-- The UK and Group catalogues are the 01- prefixed codes. Everything else is deprecated, and is
-- deleted rather than hidden.
--
-- Dean, 22 Sep 2026: "really it should only be the xero_item_codes with the 01- prefix these
-- others are deprecated" and then, looking at the table, "now theres 20000 + records but they are
-- not being used".
--
-- He is right on both counts. The previous rule kept anything Xero gave an account code to, which
-- left 145 UK entries instead of 19,937, but it still RECORDED all 19,942 and it still let through
-- 110 UK codes like Advertising, Adobe Software and Bull Barriers that nobody orders on an
-- intercompany barrier order. A row that is never used is not free: it is twenty thousand rows
-- every reader of this table pages through.
--
-- 🔴 THE PREFIX, NOT THE SALES ACCOUNT. Dean offered both tests in one sentence. They are not the
-- same set and the prefix is the right one:
--
--   UK     35 codes are 01- prefixed, and all 35 carry a sales account. The two agree.
--   GROUP  17 codes are 01- prefixed, and only 4 carry a sales account. Requiring a sales account
--          would delete 01-EBH9, 01-EBH10, 01-EBH9X, 01-DBRS and 01-HERAS, which are the actual
--          barriers Group orders. They are purchase-side items in that tenant and carry a purchase
--          account instead.
--
-- So: prefix. The two organisations that use the convention get it; the other five never adopted it
-- (USA is H9BALT, France is H9, s.r.o. is H9SK) and are untouched.
--
-- THIS DELETES ROWS, on purpose, and only rows the SYNC created. A hand-made row is never deleted.
-- There are none to worry about today, because every one of the 12 UK and 17 Group hand-made rows
-- is already 01- prefixed, but the rule is written so that stays true.

-- ---------------------------------------------------------------------------
-- 1. A rule can now say "not ours" as well as "this depot"
-- ---------------------------------------------------------------------------
alter table public.xero_org_depot_rule
  add column if not exists is_excluded boolean not null default false;

comment on column public.xero_org_depot_rule.is_excluded is
  'A matching rule that means the item is deliberately not ours: not recorded, not offered, and not reported as a problem. Distinct from no rule matching at all, which IS reported, because an unclaimed code is usually a code somebody needs to look at.';

-- The UK and Group catch-alls stop being "everything else is ours" and become "everything else is
-- deprecated". The 01- rules are added above them.
insert into public.xero_org_depot_rule (xero_org, depot_code, code_pattern, priority, note, is_excluded) values
  ('UK',    'GB-BSE',   '^01-', 10, 'The UK catalogue is the 01- prefixed codes', false),
  ('GROUP', 'EB-GROUP', '^01-', 10, 'The Group catalogue is the 01- prefixed codes', false)
on conflict (xero_org, depot_code, priority) do update
  set code_pattern = excluded.code_pattern, note = excluded.note, is_excluded = excluded.is_excluded;

update public.xero_org_depot_rule
set is_excluded = true,
    note = 'Deprecated. Anything without the 01- prefix, including the hire fleet, one Xero item per physical barrier.'
where xero_org in ('UK', 'GROUP') and code_pattern is null;

-- ---------------------------------------------------------------------------
-- 2. The rule, as a function, now answering both questions
-- ---------------------------------------------------------------------------
create or replace function public.xero_item_rule(p_xero_org text, p_item_code text)
returns table (depot_code text, is_excluded boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select r.depot_code, r.is_excluded
  from public.xero_org_depot_rule r
  where upper(r.xero_org) = upper(coalesce(p_xero_org, ''))
    and (r.code_pattern is null or coalesce(p_item_code, '') ~* r.code_pattern)
  order by r.priority
  limit 1;
$$;

comment on function public.xero_item_rule(text, text) is
  'Which depot a Xero item belongs to and whether it is deliberately excluded. No row at all means no rule claimed it, which the reconcile reports rather than guessing at.';

-- depot_for_xero_item is kept and still answers the depot question, but now returns null for an
-- excluded item as well as an unclaimed one, so any older caller stops offering deprecated codes.
create or replace function public.depot_for_xero_item(p_xero_org text, p_item_code text)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select r.depot_code from public.xero_item_rule(p_xero_org, p_item_code) r where not r.is_excluded;
$$;

-- ---------------------------------------------------------------------------
-- 3. The reconcile: skip excluded items, and clear out any it created before
-- ---------------------------------------------------------------------------
create or replace function public.xero_items_commit(p_batch_id text, p_xero_org text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n_staged int; n_recognised int; n_excluded int := 0; n_created int := 0; n_updated int := 0;
  n_archived int := 0; n_flagged int := 0; n_deleted int := 0;
  v_unmapped text[] := '{}';
begin
  delete from public.xero_item_stage where staged_at < now() - interval '1 day';

  select count(*) into n_staged from public.xero_item_stage
  where batch_id = p_batch_id and upper(xero_org) = upper(p_xero_org);

  if n_staged = 0 then
    raise exception 'xero_items_commit found nothing staged for % in batch %: refusing to retire every synced row', p_xero_org, p_batch_id;
  end if;

  create temporary table _batch on commit drop as
  select s.*, r.depot_code as depot, coalesce(r.is_excluded, false) as excluded
  from public.xero_item_stage s
  left join lateral public.xero_item_rule(p_xero_org, s.code) r on true
  where s.batch_id = p_batch_id and upper(s.xero_org) = upper(p_xero_org);

  create index on _batch (depot, upper(code));

  -- Excluded is deliberate and silent. Unclaimed is reported, because a code no rule matches is
  -- usually a code somebody needs to look at.
  select count(*) into n_excluded from _batch where excluded;
  select coalesce(array_agg(code order by code), '{}') into v_unmapped
    from _batch where depot is null and not excluded;
  select count(*) into n_recognised from _batch where depot is not null and not excluded;

  if n_recognised = 0 then
    delete from public.xero_item_stage where batch_id = p_batch_id;
    return jsonb_build_object('xero_org', p_xero_org, 'received', n_staged,
      'created', 0, 'updated', 0, 'retired', 0, 'flagged', 0, 'deleted', 0,
      'excluded', n_excluded, 'unmapped_count', coalesce(array_length(v_unmapped, 1), 0),
      'unmapped', to_jsonb(v_unmapped[1:25]),
      'warning', 'no item matched a depot rule, so nothing was retired');
  end if;

  -- An item the rules now exclude, on a row the sync created earlier, is deleted rather than left
  -- switched off. Dean, 22 Sep 2026: "now theres 20000 + records but they are not being used." A
  -- hand-made row is never deleted, whatever the rules say.
  delete from public.product_depot_mapping m
  using _batch b
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'xero'
    and b.excluded
    and upper(btrim(m.xero_item_code)) = upper(b.code);
  get diagnostics n_deleted = row_count;

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
    and not b.excluded
    and m.depot_code = b.depot
    and upper(btrim(m.xero_item_code)) = upper(b.code);
  get diagnostics n_updated = row_count;

  -- Orderable when Xero says the item is purchased AND gives it an account to code to. The Hub
  -- does not ask a raiser to choose an account, so an item with neither cannot be coded.
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
  where b.depot is not null and not b.excluded
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
      where not b.excluded and b.depot = m.depot_code and upper(b.code) = upper(btrim(m.xero_item_code)));
  get diagnostics n_archived = row_count;

  update public.product_depot_mapping m set
    xero_is_archived = true, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org) and m.source = 'manual'
    and not m.xero_is_archived
    and not exists (select 1 from _batch b
      where not b.excluded and b.depot = m.depot_code and upper(b.code) = upper(btrim(m.xero_item_code)));
  get diagnostics n_flagged = row_count;

  delete from public.xero_item_stage where batch_id = p_batch_id;

  return jsonb_build_object(
    'xero_org', p_xero_org,
    'received', n_staged,
    'recognised', n_recognised,
    'excluded', n_excluded,
    'created', n_created,
    'updated', n_updated,
    'retired', n_archived,
    'deleted', n_deleted,
    'flagged', n_flagged,
    'flagged_total', (select count(*) from public.product_depot_mapping m
                      where upper(m.xero_org) = upper(p_xero_org) and m.source = 'manual' and m.xero_is_archived),
    'active_total', (select count(*) from public.product_depot_mapping m
                     where upper(m.xero_org) = upper(p_xero_org) and m.is_active),
    'unmapped_count', coalesce(array_length(v_unmapped, 1), 0),
    'unmapped', to_jsonb(v_unmapped[1:25])
  );
end $$;

comment on function public.xero_items_commit(text, text) is
  'Reconcile one Xero organisation from its staged batch. Items a rule excludes are skipped and any row the sync made for them is deleted. Orderable requires Xero to say the item is purchased and to give it an account. A hand-made row is never deleted and never switched off.';

-- ---------------------------------------------------------------------------
-- 4. Clear out what the earlier runs created
-- ---------------------------------------------------------------------------
delete from public.product_depot_mapping m
where m.source = 'xero'
  and exists (
    select 1 from public.xero_item_rule(m.xero_org, m.xero_item_code) r where r.is_excluded
  );

revoke all on function public.xero_item_rule(text, text) from public, anon, authenticated;
revoke all on function public.depot_for_xero_item(text, text) from public, anon, authenticated;
revoke all on function public.xero_items_commit(text, text) from public, anon, authenticated;
grant execute on function public.xero_item_rule(text, text) to service_role;
grant execute on function public.depot_for_xero_item(text, text) to service_role;
grant execute on function public.xero_items_commit(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare uk int; grp int; strays int; manual_lost int;
begin
  select count(*) into uk from public.product_depot_mapping where xero_org = 'UK';
  select count(*) into grp from public.product_depot_mapping where xero_org = 'GROUP';

  if uk > 60 then raise exception 'the UK still holds % rows; the prefix rule did not bite', uk; end if;
  if uk < 30 then raise exception 'the UK is down to % rows; too much was deleted', uk; end if;
  if grp > 40 then raise exception 'Group still holds % rows', grp; end if;

  -- Every hand-made row must still be there. Deleting somebody's mapping is never this
  -- migration's business.
  select count(*) into manual_lost from (
    select 1 from public.product_depot_mapping where source = 'manual' and xero_org = 'UK'
  ) t;
  if manual_lost <> 12 then raise exception 'the UK has % hand-made rows, expected 12', manual_lost; end if;
  select count(*) into manual_lost from (
    select 1 from public.product_depot_mapping where source = 'manual' and xero_org = 'GROUP'
  ) t;
  if manual_lost <> 17 then raise exception 'Group has % hand-made rows, expected 17', manual_lost; end if;

  -- Nothing without the prefix may survive in those two organisations.
  select count(*) into strays from public.product_depot_mapping
  where xero_org in ('UK', 'GROUP') and xero_item_code not ilike '01-%';
  if strays > 0 then raise exception '% rows without the 01- prefix survived in UK or Group', strays; end if;

  -- And the five organisations that never used the convention must be untouched.
  if (select count(*) from public.product_depot_mapping where xero_org = 'USA') <> 108 then
    raise exception 'the USA row count changed; only UK and Group were in scope';
  end if;
  if public.depot_for_xero_item('USA', 'H9BALT') <> 'US-BAL' then
    raise exception 'the USA rules stopped working';
  end if;
  if public.depot_for_xero_item('UK', '01-EBH9') <> 'GB-BSE' then
    raise exception 'a UK 01- code no longer resolves';
  end if;
  if public.depot_for_xero_item('UK', 'Adobe') is not null then
    raise exception 'a deprecated UK code still resolves to a depot';
  end if;
  if public.depot_for_xero_item('GROUP', '01-EBH9') <> 'EB-GROUP' then
    raise exception 'a Group 01- code no longer resolves';
  end if;
end $$;
