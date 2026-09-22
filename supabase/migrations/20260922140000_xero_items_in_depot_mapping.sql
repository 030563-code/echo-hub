-- Every Xero item, in the table that decides what a depot may order, whether or not
-- anybody has ever given it a HubSpot SKU. And the reconcile that keeps it true.
--
-- Dean, 22 Sep 2026: "Please pull through all xero_item_codes for all organisations onto the
-- product_depot_mapping table even if they dont have a hubspot sku code make sure it reflects
-- whats in Xero at all times and even checks automatically via n8n when something new is added so
-- it updates that table."
--
-- WHAT STOPPED IT. product_depot_mapping.hubspot_sku_code was NOT NULL. So a product that exists
-- in Xero and has never been given a HubSpot SKU could not be recorded at all, and the raise-a-PO
-- dropdown could not offer it. That is the wrong way round: the Xero item code is the thing that
-- has to be right, because it is what lands on the purchase order in Xero. A HubSpot SKU is how
-- the sales side happens to name the same product, and plenty of Xero items (shipping lines,
-- ex-rental stock, one-off charges) will never have one.
--
-- 🔴 THE IDENTITY IS NOT WHAT IT LOOKS LIKE. The first draft of this migration made
-- (xero_org, xero_item_code, depot_code) unique. A dry run against production refused it: four
-- rows already break that, because EBH10HERC and EBH10HERCNA BOTH point at H10HERCB for
-- Baltimore, the first switched off and the second on. Several HubSpot SKUs mapping to one Xero
-- item is the normal state of a mapping table, not a fault. So the existing key is left exactly as
-- it is and the new one covers only the rows it can: those with no SKU at all.
--
-- 🔴 A SYNC MUST NOT OVERWRITE A PERSON. The rows here were decided by hand and some of them
-- disagree with Xero on purpose, as the HERC pair shows. So the reconcile is told what it owns. It
-- refreshes Xero's OWN fields on any row, creates a row for an item nobody has mapped, and
-- switches off only the rows it created itself. It never touches hubspot_sku_code, product_family,
-- or the is_active flag on a row a person made.

-- ---------------------------------------------------------------------------
-- 1. A Xero item no longer needs a HubSpot SKU
-- ---------------------------------------------------------------------------
alter table public.product_depot_mapping alter column hubspot_sku_code drop not null;

comment on column public.product_depot_mapping.hubspot_sku_code is
  'How the sales side names this product, where it names it at all. Optional since 22 Sep 2026: the Xero item code is what reaches Xero, and a shipping line or an ex-rental item may never have a HubSpot SKU. Several SKUs may point at one Xero item.';

-- unique_sku_per_depot is a CONSTRAINT here, not a bare index, so it cannot be dropped with DROP
-- INDEX and it does not need to be. It already permits what we need: Postgres treats two NULLs as
-- distinct, so SKU-less rows slip past it, and the index below is what catches those instead.
create unique index if not exists unique_xero_item_when_no_sku
  on public.product_depot_mapping (xero_org, xero_item_code, depot_code)
  where hubspot_sku_code is null;

comment on index public.unique_xero_item_when_no_sku is
  'One row per Xero item per depot among the rows the sync owns. Partial because a product WITH a HubSpot SKU is keyed by that SKU, and two SKUs pointing at one Xero item is legitimate.';

-- ---------------------------------------------------------------------------
-- 2. What the reconcile needs to know
-- ---------------------------------------------------------------------------
alter table public.product_depot_mapping
  -- Xero's own ItemID. The code can be renamed in Xero and this cannot.
  add column if not exists xero_item_id uuid,
  -- 'manual' was decided by a person and is never switched off by the sync.
  -- 'xero' was created by the sync and may be switched off by it.
  add column if not exists source text not null default 'manual',
  -- The last run that saw this item in Xero.
  add column if not exists last_seen_in_xero_at timestamptz,
  -- Xero's own figures, carried through so a screen can show them without a second call.
  add column if not exists xero_unit_price numeric,
  add column if not exists xero_sales_account_code text,
  add column if not exists xero_purchase_account_code text,
  -- Xero's own decision about the item, kept apart from is_active, which is OURS about whether a
  -- depot may order it, so neither can quietly overwrite the other.
  add column if not exists xero_is_archived boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_depot_mapping'::regclass and conname = 'product_depot_mapping_source_known'
  ) then
    alter table public.product_depot_mapping
      add constraint product_depot_mapping_source_known check (source in ('manual', 'xero'));
  end if;
end $$;

comment on column public.product_depot_mapping.source is
  'manual: a person decided this row; the sync refreshes Xero''s own fields on it and nothing else. xero: the sync created it and may switch it off when the item leaves Xero.';
comment on column public.product_depot_mapping.xero_item_id is
  'Xero''s ItemID. Survives a rename of the item code, which the code itself does not.';
comment on column public.product_depot_mapping.is_active is
  'OUR decision: may this depot order this product. Separate from xero_is_archived, which is Xero''s decision about the item.';

create index if not exists idx_product_mapping_xero_item on public.product_depot_mapping (xero_item_code);
create index if not exists idx_product_mapping_source on public.product_depot_mapping (source);

-- ---------------------------------------------------------------------------
-- 3. Which depot a Xero organisation's items belong to
-- ---------------------------------------------------------------------------
-- Six of the seven organisations have exactly one depot, so an item lands without a decision. The
-- USA tenant holds BOTH American depots and tells them apart only through the item code
-- (H9BALT against H9SB, LTL-BAL-001 against LTL-SBD-001). This table is that rule, written down
-- and editable, rather than a regular expression buried in a workflow nobody can find.
create table if not exists public.xero_org_depot_rule (
  xero_org text not null,
  depot_code text not null,
  -- A case-insensitive regular expression matched against the item CODE. Null means "everything in
  -- this organisation that no earlier rule claimed", which is how a single-depot organisation is
  -- expressed and how an unrecognised American code still lands somewhere.
  code_pattern text,
  -- Lower runs first. The catch-all for an organisation must sort last.
  priority integer not null default 100,
  note text,
  primary key (xero_org, depot_code, priority)
);

comment on table public.xero_org_depot_rule is
  'Which depot a Xero item belongs to, by organisation and item code. Exists because the USA tenant serves two depots and says which only through the code.';

-- 🔴 The American rules are fitted to the codes that exist and they are ORDER DEPENDENT.
-- Baltimore is claimed FIRST, because several Baltimore codes contain the letters SB by accident
-- (CSSBALT is a compact cutting station at Baltimore) and several San Bernardino codes end in B
-- (H10SB), so either test alone gets the other depot wrong. Baltimore is also the catch-all, so a
-- new code matching neither lands there and a person can move it; the alternative is a product
-- that exists in Xero and belongs to no depot, which is the bug this migration is about. H9SBXR,
-- the ex-rental line, is why the San Bernardino test is not anchored to the end of the code.
insert into public.xero_org_depot_rule (xero_org, depot_code, code_pattern, priority, note) values
  ('USA',       'US-BAL',   'BALT|-BAL-', 10, 'Baltimore names itself: H9BALT, CSSBALT, LTL-BAL-001'),
  ('USA',       'US-SBD',   'SB',         20, 'San Bernardino: H9SB, H9XSB, H9SBXR, LTL-SBD-001'),
  ('USA',       'US-BAL',   null,        900, 'Anything else in the USA tenant lands at Baltimore'),
  ('CANADA',    'CA-HAM',   null,        900, 'One depot'),
  ('FRANCE',    'EU-FR',    null,        900, 'One depot'),
  ('UK',        'GB-BSE',   null,        900, 'One depot'),
  ('SLOVAKIA',  'EB-SRO',   null,        900, 'The company, not a depot: s.r.o. raises its own orders'),
  ('GROUP',     'EB-GROUP', null,        900, 'The company, not a depot'),
  ('AUSTRALIA', 'AU-SYD',   null,        900, 'One depot. Nothing is mapped there yet.')
on conflict do nothing;

create or replace function public.depot_for_xero_item(p_xero_org text, p_item_code text)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select r.depot_code
  from public.xero_org_depot_rule r
  where upper(r.xero_org) = upper(coalesce(p_xero_org, ''))
    and (r.code_pattern is null or coalesce(p_item_code, '') ~* r.code_pattern)
  order by r.priority
  limit 1;
$$;

comment on function public.depot_for_xero_item(text, text) is
  'The depot a Xero item belongs to, by the rules in xero_org_depot_rule. Null when the organisation has no rule at all, which the reconcile reports rather than guessing at.';

-- ---------------------------------------------------------------------------
-- 4. The reconcile
-- ---------------------------------------------------------------------------
-- n8n's whole job becomes: get the items for one tenant, post them here. The decisions live in the
-- database, where they can be read and tested, rather than in a Code node.
--
-- p_items is Xero's own /Items array, unmodified: [{ItemID, Code, Name, Description, IsSold,
-- IsPurchased, SalesDetails:{UnitPrice, AccountCode}, PurchaseDetails:{UnitPrice, AccountCode}}].
create or replace function public.sync_xero_items(p_xero_org text, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_code text;
  v_depot text;
  v_desc text;
  v_touched int;
  n_created int := 0;
  n_updated int := 0;
  n_archived int := 0;
  unmapped text[] := '{}';
  seen text[] := '{}';
begin
  if p_xero_org is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'sync_xero_items needs an organisation and an array of items';
  end if;

  -- An empty array is refused rather than obeyed. A tenant that answers with nothing is almost
  -- always a broken call, and obeying it would switch off every product that organisation sells.
  if jsonb_array_length(p_items) = 0 then
    raise exception 'sync_xero_items refused an empty item list for %: that would retire every synced row', p_xero_org;
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    v_code := nullif(btrim(item->>'Code'), '');
    continue when v_code is null;

    v_depot := public.depot_for_xero_item(p_xero_org, v_code);
    if v_depot is null then
      unmapped := unmapped || v_code;
      continue;
    end if;

    seen := seen || v_code;
    -- Xero calls it Name on an item and Description on the sales side; take whichever it sent.
    v_desc := coalesce(nullif(btrim(item->>'Name'), ''), nullif(btrim(item->>'Description'), ''));

    -- Refresh EVERY row for this item at this depot. There can be more than one: two HubSpot SKUs
    -- may point at a single Xero item, and both of them want Xero's current name and price.
    update public.product_depot_mapping m set
      xero_item_id = coalesce((item->>'ItemID')::uuid, m.xero_item_id),
      xero_item_description = coalesce(v_desc, m.xero_item_description),
      xero_unit_price = coalesce((item#>>'{SalesDetails,UnitPrice}')::numeric, m.xero_unit_price),
      xero_sales_account_code = coalesce(item#>>'{SalesDetails,AccountCode}', m.xero_sales_account_code),
      xero_purchase_account_code = coalesce(item#>>'{PurchaseDetails,AccountCode}', m.xero_purchase_account_code),
      xero_is_archived = false,
      last_seen_in_xero_at = now(),
      updated_at = now()
    where upper(m.xero_org) = upper(p_xero_org)
      and m.depot_code = v_depot
      and btrim(m.xero_item_code) = v_code;
    get diagnostics v_touched = row_count;

    if v_touched > 0 then
      n_updated := n_updated + v_touched;
    else
      -- Nobody has mapped this item. Record it so it can be ordered, with no HubSpot SKU and no
      -- product family, both of which are a person's to fill in later.
      insert into public.product_depot_mapping (
        hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description,
        is_active, source, xero_item_id, xero_unit_price, xero_sales_account_code,
        xero_purchase_account_code, xero_is_archived, last_seen_in_xero_at
      ) values (
        null, v_depot, upper(p_xero_org), v_code, v_desc,
        true, 'xero', (item->>'ItemID')::uuid,
        (item#>>'{SalesDetails,UnitPrice}')::numeric,
        item#>>'{SalesDetails,AccountCode}',
        item#>>'{PurchaseDetails,AccountCode}',
        false, now()
      )
      on conflict (xero_org, xero_item_code, depot_code) where hubspot_sku_code is null do nothing;
      get diagnostics v_touched = row_count;
      n_created := n_created + v_touched;
    end if;
  end loop;

  -- 🔴 Retire nothing unless we actually recognised something. A tenant whose items ALL fall
  -- outside the depot rules would otherwise leave `seen` empty and retire every synced row, which
  -- is the same disaster as an empty response wearing a different hat.
  if array_length(seen, 1) is null then
    return jsonb_build_object(
      'xero_org', p_xero_org,
      'received', jsonb_array_length(p_items),
      'created', 0, 'updated', 0, 'retired', 0,
      'unmapped', to_jsonb(unmapped),
      'warning', 'no item matched a depot rule, so nothing was retired'
    );
  end if;

  -- An item that has left Xero. Only rows the sync created are retired; a person's row is left
  -- exactly as they set it, with xero_is_archived recording what Xero now thinks.
  update public.product_depot_mapping m set
    xero_is_archived = true,
    is_active = false,
    updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'xero'
    and not (btrim(m.xero_item_code) = any (seen))
    and (m.is_active or not m.xero_is_archived);
  get diagnostics n_archived = row_count;

  update public.product_depot_mapping m set xero_is_archived = true, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'manual'
    and not (btrim(m.xero_item_code) = any (seen))
    and not m.xero_is_archived;

  return jsonb_build_object(
    'xero_org', p_xero_org,
    'received', jsonb_array_length(p_items),
    'created', n_created,
    'updated', n_updated,
    'retired', n_archived,
    'unmapped', to_jsonb(unmapped)
  );
end $$;

comment on function public.sync_xero_items(text, jsonb) is
  'Reconcile one Xero organisation''s /Items response into product_depot_mapping. Creates a row for an item nobody has mapped, refreshes Xero''s own fields on every row, and retires only the rows it created itself. Refuses an empty list.';

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------
alter table public.xero_org_depot_rule enable row level security;

drop policy if exists "Service role full access" on public.xero_org_depot_rule;
create policy "Service role full access"
  on public.xero_org_depot_rule for all to service_role
  using (true) with check (true);

revoke all on public.xero_org_depot_rule from public, anon, authenticated;
grant all on public.xero_org_depot_rule to service_role;

-- The reconcile runs as its caller, so only a service-role caller can write through it.
revoke all on function public.sync_xero_items(text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_xero_items(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare bad text;
begin
  if (select is_nullable from information_schema.columns
      where table_schema='public' and table_name='product_depot_mapping' and column_name='hubspot_sku_code') <> 'YES' then
    raise exception 'hubspot_sku_code is still NOT NULL';
  end if;

  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='unique_xero_item_when_no_sku'
      and indexdef ilike '%WHERE (hubspot_sku_code IS NULL)%'
  ) then
    raise exception 'the SKU-less identity index is missing or is not partial';
  end if;

  -- The pair that broke the first draft must still be allowed to exist.
  if (select count(*) from public.product_depot_mapping
      where xero_org='USA' and xero_item_code='H10HERCB' and depot_code='US-BAL') <> 2 then
    raise exception 'the two HERC rows are no longer both present';
  end if;

  -- The rules must place every code we already hold exactly where it already sits.
  for bad in
    select m.xero_org || ' ' || m.xero_item_code
    from public.product_depot_mapping m
    where public.depot_for_xero_item(m.xero_org, m.xero_item_code) is distinct from m.depot_code
  loop
    raise exception 'the depot rules would move % away from where it already sits', bad;
  end loop;

  -- The four cases that make the order of the American rules matter.
  if public.depot_for_xero_item('USA', 'H9SB') <> 'US-SBD' then
    raise exception 'a San Bernardino code did not resolve to US-SBD';
  end if;
  if public.depot_for_xero_item('USA', 'H9SBXR') <> 'US-SBD' then
    raise exception 'the ex-rental San Bernardino code did not resolve to US-SBD';
  end if;
  if public.depot_for_xero_item('USA', 'CSSBALT') <> 'US-BAL' then
    raise exception 'a Baltimore code containing SB resolved to San Bernardino';
  end if;
  if public.depot_for_xero_item('USA', 'H10SB') <> 'US-SBD' then
    raise exception 'a San Bernardino code ending in B resolved to Baltimore';
  end if;
  if public.depot_for_xero_item('NOWHERE', 'X') is not null then
    raise exception 'an unmapped organisation should resolve to nothing, not to a guess';
  end if;

  -- The reconcile must refuse an empty list rather than retire everything.
  begin
    perform public.sync_xero_items('USA', '[]'::jsonb);
    raise exception 'sync_xero_items accepted an empty item list';
  exception when others then
    if sqlerrm not like '%refused an empty item list%' then raise; end if;
  end;
end $$;
