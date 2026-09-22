-- Reconcile an organisation of any size, and let Xero say what can be put on a purchase order.
--
-- 🔴 THE UK XERO ORGANISATION HAS 19,942 ITEMS. Not a few hundred. That is the fact that broke
-- the first two attempts and it changes the shape of the problem twice over.
--
-- First, size. Even set-based, one request carrying twenty thousand items exceeds PostgREST's
-- eight second statement timeout, and the UK silently lost its refresh while the other six looked
-- fine. So the items now arrive in batches through xero_item_stage and are reconciled once, at
-- the end, from the staged set. Any catalogue fits, because no single request has to carry it.
--
-- Second, and more important: product_depot_mapping feeds the dropdown somebody picks lines from
-- when raising a PURCHASE order. Twenty thousand entries is not a list, it is a haystack, and
-- switching them all on would make the screen worse for the six organisations that already work.
-- So a row the sync creates is only ACTIVE when Xero itself says the item is purchased. That is
-- not an arbitrary cut: IsPurchased is Xero's own answer to "can this go on a purchase order",
-- which is exactly the question the dropdown asks. Everything else is still recorded, with
-- is_active false, so nothing is lost and a person can switch on whatever they want.
--
-- A row a PERSON made is never touched by this. Their is_active stands whatever Xero thinks.

create table if not exists public.xero_item_stage (
  -- One run of one organisation. The workflow builds it from the execution id, so a retry cannot
  -- collide with a run still in flight.
  batch_id text not null,
  xero_org text not null,
  code text not null,
  descr text,
  item_id uuid,
  unit_price numeric,
  sales_account text,
  purchase_account text,
  is_purchased boolean,
  is_sold boolean,
  staged_at timestamptz not null default now(),
  primary key (batch_id, code)
);

comment on table public.xero_item_stage is
  'Items arriving from Xero one batch at a time, so an organisation of any size can be reconciled without a single request exceeding the statement timeout. Emptied by xero_items_commit; anything older than a day is a run that died and is swept on the next commit.';

create index if not exists idx_xero_item_stage_org on public.xero_item_stage (xero_org, batch_id);

alter table public.xero_item_stage enable row level security;
drop policy if exists "Service role full access" on public.xero_item_stage;
create policy "Service role full access" on public.xero_item_stage for all to service_role
  using (true) with check (true);
revoke all on public.xero_item_stage from public, anon, authenticated;
grant all on public.xero_item_stage to service_role;

-- ---------------------------------------------------------------------------
-- Stage one batch
-- ---------------------------------------------------------------------------
create or replace function public.xero_items_stage(p_batch_id text, p_xero_org text, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare n int;
begin
  if p_batch_id is null or p_xero_org is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'xero_items_stage needs a batch id, an organisation and an array of items';
  end if;

  insert into public.xero_item_stage (
    batch_id, xero_org, code, descr, item_id, unit_price, sales_account, purchase_account,
    is_purchased, is_sold
  )
  select distinct on (upper(s.code))
    p_batch_id, upper(p_xero_org), s.code, s.descr, s.item_id, s.unit_price,
    s.sales_account, s.purchase_account, s.is_purchased, s.is_sold
  from (
    select
      nullif(btrim(e->>'Code'), '') as code,
      coalesce(nullif(btrim(e->>'Name'), ''), nullif(btrim(e->>'Description'), '')) as descr,
      nullif(e->>'ItemID', '')::uuid as item_id,
      (e#>>'{SalesDetails,UnitPrice}')::numeric as unit_price,
      e#>>'{SalesDetails,AccountCode}' as sales_account,
      e#>>'{PurchaseDetails,AccountCode}' as purchase_account,
      (e->>'IsPurchased')::boolean as is_purchased,
      (e->>'IsSold')::boolean as is_sold
    from jsonb_array_elements(p_items) e
  ) s
  where s.code is not null
  on conflict (batch_id, code) do nothing;
  get diagnostics n = row_count;

  return jsonb_build_object('batch_id', p_batch_id, 'xero_org', p_xero_org,
                            'received', jsonb_array_length(p_items), 'staged', n);
end $$;

comment on function public.xero_items_stage(text, text, jsonb) is
  'Add one batch of Xero items to the staging table. Safe to call repeatedly for the same batch.';

-- ---------------------------------------------------------------------------
-- Reconcile from what was staged
-- ---------------------------------------------------------------------------
create or replace function public.xero_items_commit(p_batch_id text, p_xero_org text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n_staged int; n_recognised int; n_created int := 0; n_updated int := 0;
  n_archived int := 0; n_flagged int := 0;
  v_unmapped text[] := '{}';
begin
  -- A run that died halfway leaves rows behind. Sweep anything older than a day before doing
  -- anything else, so the table cannot grow without bound.
  delete from public.xero_item_stage where staged_at < now() - interval '1 day';

  select count(*) into n_staged from public.xero_item_stage
  where batch_id = p_batch_id and upper(xero_org) = upper(p_xero_org);

  -- Nothing staged is the same refusal as an empty list: obeying it retires the catalogue.
  if n_staged = 0 then
    raise exception 'xero_items_commit found nothing staged for % in batch %: refusing to retire every synced row', p_xero_org, p_batch_id;
  end if;

  create temporary table _batch on commit drop as
  select s.*, public.depot_for_xero_item(p_xero_org, s.code) as depot
  from public.xero_item_stage s
  where s.batch_id = p_batch_id and upper(s.xero_org) = upper(p_xero_org);

  create index on _batch (depot, upper(code));

  select coalesce(array_agg(code order by code), '{}') into v_unmapped from _batch where depot is null;
  select count(*) into n_recognised from _batch where depot is not null;

  if n_recognised = 0 then
    delete from public.xero_item_stage where batch_id = p_batch_id;
    return jsonb_build_object('xero_org', p_xero_org, 'received', n_staged,
      'created', 0, 'updated', 0, 'retired', 0, 'flagged', 0,
      'unmapped', to_jsonb(v_unmapped),
      'warning', 'no item matched a depot rule, so nothing was retired');
  end if;

  -- Refresh Xero's own fields on every row for these items, whoever made the row.
  update public.product_depot_mapping m set
    xero_item_id = coalesce(b.item_id, m.xero_item_id),
    xero_item_description = coalesce(b.descr, m.xero_item_description),
    xero_unit_price = coalesce(b.unit_price, m.xero_unit_price),
    xero_sales_account_code = coalesce(b.sales_account, m.xero_sales_account_code),
    xero_purchase_account_code = coalesce(b.purchase_account, m.xero_purchase_account_code),
    xero_is_archived = false,
    last_seen_in_xero_at = now(),
    updated_at = now()
  from _batch b
  where upper(m.xero_org) = upper(p_xero_org)
    and m.depot_code = b.depot
    and upper(btrim(m.xero_item_code)) = upper(b.code);
  get diagnostics n_updated = row_count;

  -- An item nobody has mapped. 🔴 Active only when Xero says it is PURCHASED, because this table
  -- feeds the dropdown for raising a purchase order and an item you only sell is not a line on
  -- one. Null means Xero did not say, and a product we know nothing against is offered rather
  -- than hidden. Everything else is recorded and switched off, losing nothing.
  insert into public.product_depot_mapping (
    hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description,
    is_active, source, xero_item_id, xero_unit_price, xero_sales_account_code,
    xero_purchase_account_code, xero_is_archived, last_seen_in_xero_at
  )
  select null, b.depot, upper(p_xero_org), b.code, b.descr,
         coalesce(b.is_purchased, true), 'xero', b.item_id, b.unit_price,
         b.sales_account, b.purchase_account, false, now()
  from _batch b
  where b.depot is not null
    and not exists (
      select 1 from public.product_depot_mapping m
      where upper(m.xero_org) = upper(p_xero_org)
        and m.depot_code = b.depot
        and upper(btrim(m.xero_item_code)) = upper(b.code))
  on conflict (xero_org, xero_item_code, depot_code) where hubspot_sku_code is null do nothing;
  get diagnostics n_created = row_count;

  -- Gone from Xero, on a row the sync created. Switched off, because it owns it.
  update public.product_depot_mapping m set
    xero_is_archived = true, is_active = false, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org) and m.source = 'xero'
    and (m.is_active or not m.xero_is_archived)
    and not exists (select 1 from _batch b
      where b.depot = m.depot_code and upper(b.code) = upper(btrim(m.xero_item_code)));
  get diagnostics n_archived = row_count;

  -- Gone from Xero, on a row a PERSON made. Flagged and left alone: overruling their mapping is
  -- their call. This is the number that should make somebody look.
  update public.product_depot_mapping m set
    xero_is_archived = true, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org) and m.source = 'manual'
    and not m.xero_is_archived
    and not exists (select 1 from _batch b
      where b.depot = m.depot_code and upper(b.code) = upper(btrim(m.xero_item_code)));
  get diagnostics n_flagged = row_count;

  delete from public.xero_item_stage where batch_id = p_batch_id;

  return jsonb_build_object(
    'xero_org', p_xero_org,
    'received', n_staged,
    'recognised', n_recognised,
    'created', n_created,
    'updated', n_updated,
    'retired', n_archived,
    'flagged', n_flagged,
    -- The standing total, not this run's change: `flagged` reads 0 on every run after the first,
    -- which would make a real problem look like it had gone away.
    'flagged_total', (select count(*) from public.product_depot_mapping m
                      where upper(m.xero_org) = upper(p_xero_org) and m.source = 'manual' and m.xero_is_archived),
    'active_total', (select count(*) from public.product_depot_mapping m
                     where upper(m.xero_org) = upper(p_xero_org) and m.is_active),
    'unmapped_count', array_length(v_unmapped, 1),
    'unmapped', to_jsonb(v_unmapped[1:25])
  );
end $$;

comment on function public.xero_items_commit(text, text) is
  'Reconcile one Xero organisation from its staged batch into product_depot_mapping, then clear the batch. A row the sync creates is active only when Xero says the item is purchased, because this table feeds the raise-a-purchase-order dropdown.';

revoke all on function public.xero_items_stage(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.xero_items_commit(text, text) from public, anon, authenticated;
grant execute on function public.xero_items_stage(text, text, jsonb) to service_role;
grant execute on function public.xero_items_commit(text, text) to service_role;

do $$
begin
  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema='public' and routine_name in ('xero_items_stage','xero_items_commit')
      and grantee in ('PUBLIC','anon','authenticated')
  ) then
    raise exception 'anon, authenticated or PUBLIC hold EXECUTE on the staging functions';
  end if;
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='xero_item_stage' and rowsecurity) then
    raise exception 'row level security is off on xero_item_stage';
  end if;
end $$;
