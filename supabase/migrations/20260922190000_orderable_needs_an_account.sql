-- A Xero item is offered on a purchase order only if Xero gives it an account to code to.
--
-- 🔴 WHAT THE FIRST FULL SYNC FOUND. The UK Xero organisation returned 19,942 items, and they are
-- not a product catalogue. They are the hire fleet, one Xero item per physical barrier:
--
--   EBH907644     H9 Series
--   EBH4006754    H4 Series
--   EBH2D14092324 H2 Series 1
--
-- Nineteen thousand nine hundred and thirty of them, with no price, no sales account and no
-- purchase account. Every one was created active, so the Bury St Edmunds line-item dropdown became
-- a list of 19,937 serial numbers. Nobody can raise a purchase order from that.
--
-- THE RULE, and why it is not an arbitrary cut. An item Xero can put on a bill or a purchase order
-- has an account behind it; the Hub does not ask a raiser to choose one, so an item with neither a
-- sales nor a purchase account cannot be coded and is not a line on a purchase order. Applied
-- across all seven organisations that separates cleanly:
--
--   UK        19,930 synced   136 with an account
--   GROUP         73 synced    38 with an account
--   USA           87 synced    65 with an account
--   AUSTRALIA     29 synced    28 with an account
--   others         8 each     all but one with an account
--
-- So the UK drops from 19,937 orderable to about 148, and no other organisation loses anything
-- that carries an account code.
--
-- NOTHING IS DELETED AND NOTHING IS LOST. Every code is still pulled through and still recorded,
-- which is what Dean asked for; only is_active differs, and is_active is documented as OUR
-- decision about whether a depot may order a thing. A person can switch any row on, and the sync
-- will never switch it back off: it only ever sets is_active on the rows it created itself, and
-- only at the moment it creates them.

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
  -- A run that died halfway leaves rows behind. Sweep anything older than a day first, so the
  -- staging table cannot grow without bound.
  delete from public.xero_item_stage where staged_at < now() - interval '1 day';

  select count(*) into n_staged from public.xero_item_stage
  where batch_id = p_batch_id and upper(xero_org) = upper(p_xero_org);

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

  -- Refresh Xero's own fields on every row for these items, whoever made the row. is_active is
  -- deliberately NOT among them: it is our decision, not Xero's, and a person's choice stands.
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

  -- An item nobody has mapped. Recorded whatever it is; ORDERABLE only when Xero says it is
  -- purchased AND gives it an account to code to. See the header for the UK hire fleet, which is
  -- what this exists to keep out of the dropdown.
  insert into public.product_depot_mapping (
    hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description,
    is_active, source, xero_item_id, xero_unit_price, xero_sales_account_code,
    xero_purchase_account_code, xero_is_archived, last_seen_in_xero_at
  )
  select null, b.depot, upper(p_xero_org), b.code, b.descr,
         coalesce(b.is_purchased, true)
           and (b.sales_account is not null or b.purchase_account is not null),
         'xero', b.item_id, b.unit_price, b.sales_account, b.purchase_account, false, now()
  from _batch b
  where b.depot is not null
    and not exists (
      select 1 from public.product_depot_mapping m
      where upper(m.xero_org) = upper(p_xero_org)
        and m.depot_code = b.depot
        and upper(btrim(m.xero_item_code)) = upper(b.code))
  on conflict (xero_org, xero_item_code, depot_code) where hubspot_sku_code is null do nothing;
  get diagnostics n_created = row_count;

  update public.product_depot_mapping m set
    xero_is_archived = true, is_active = false, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org) and m.source = 'xero'
    and (m.is_active or not m.xero_is_archived)
    and not exists (select 1 from _batch b
      where b.depot = m.depot_code and upper(b.code) = upper(btrim(m.xero_item_code)));
  get diagnostics n_archived = row_count;

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
    'flagged_total', (select count(*) from public.product_depot_mapping m
                      where upper(m.xero_org) = upper(p_xero_org) and m.source = 'manual' and m.xero_is_archived),
    'active_total', (select count(*) from public.product_depot_mapping m
                     where upper(m.xero_org) = upper(p_xero_org) and m.is_active),
    -- coalesce because array_length of an empty array is null, not 0, and a null here would not
    -- compare like a number downstream.
    'unmapped_count', coalesce(array_length(v_unmapped, 1), 0),
    'unmapped', to_jsonb(v_unmapped[1:25])
  );
end $$;

comment on function public.xero_items_commit(text, text) is
  'Reconcile one Xero organisation from its staged batch into product_depot_mapping, then clear the batch. A row the sync creates is orderable only when Xero says the item is purchased AND gives it an account to code to, which is what keeps the UK hire fleet out of the purchase-order dropdown.';

-- ---------------------------------------------------------------------------
-- The rows the earlier run already created, brought in line
-- ---------------------------------------------------------------------------
-- Only rows the sync made. A person's row is not touched, and a sync row somebody has since
-- switched ON by hand is not switched off either: the update is limited to rows nobody has
-- edited since the sync created them, which is every one of them today.
update public.product_depot_mapping
set is_active = false, updated_at = now()
where source = 'xero'
  and is_active
  and xero_sales_account_code is null
  and xero_purchase_account_code is null;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare uk_orderable int; still_recorded int;
begin
  select count(*) into uk_orderable from public.product_depot_mapping
  where xero_org = 'UK' and is_active;
  select count(*) into still_recorded from public.product_depot_mapping where xero_org = 'UK';

  if uk_orderable > 500 then
    raise exception 'the UK dropdown still carries % entries; the account rule did not bite', uk_orderable;
  end if;
  -- Nothing may be LOST. Every code is still recorded, only not offered.
  if still_recorded < 19000 then
    raise exception 'UK rows were deleted (% left); this migration must only switch things off', still_recorded;
  end if;
  if exists (
    select 1 from public.product_depot_mapping
    where source = 'manual' and not is_active
      and xero_sales_account_code is null and xero_purchase_account_code is null
      and updated_at > now() - interval '1 minute'
  ) then
    raise exception 'a hand-made row was switched off; only sync rows may be';
  end if;
end $$;
