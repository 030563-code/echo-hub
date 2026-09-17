-- warehouse_stock_levels becomes the single source of truth for stock, every organisation.
--
-- Dean, 17 Sep 2026: "Extend the product_depot_mapping yes please, consolidate and also make
-- warehouse_stock_levels the single source of truth", after asking why the UK, France and Group
-- figures had gone into a separate xero_stock_snapshot table earlier the same day.
--
-- He was right to ask. The reason at the time was real (there was no UK, France or Group row in
-- product_depot_mapping, so there was no way to write a Hub SKU for those organisations) but the
-- result was two stock tables, which is the opposite of what he had asked for: "whats important is
-- just to have supabase as a source of truth of stock levels for all organisations".
--
-- The shape after this migration:
--   xero_stock_snapshot   the raw daily feed, keeps history, one row per org/item/date
--   warehouse_stock_levels  current state, one row per depot/SKU, what the engine reads
-- The feed flows INTO the ledger rather than sitting beside it.

-- ---------------------------------------------------------------------------
-- 1. Say where a stock figure came from
-- ---------------------------------------------------------------------------
-- 🔴 last_counted_at means "a person counted this". A figure synced out of Xero is not a count,
-- and the engine's stock_unverified flag keys off exactly that column. Without a source column,
-- either the synced rows claim a count nobody performed, or the flag fires for the depots that
-- genuinely were counted. So the source is recorded explicitly and last_counted_at is left alone.
alter table public.warehouse_stock_levels
  add column if not exists source text not null default 'count'
    check (source in ('count', 'xero_sync', 'ledger')),
  add column if not exists source_org text,
  add column if not exists source_item_code text,
  add column if not exists source_synced_at timestamptz;

comment on column public.warehouse_stock_levels.source is
  'Where quantity_on_hand came from. "count" a physical stocktake (last_counted_at is then meaningful), "xero_sync" a figure synced from the organisation Xero item ledger, "ledger" derived from stock movements. A synced row is NOT a count and must never be presented as one.';
comment on column public.warehouse_stock_levels.source_item_code is
  'For a synced row, the item code in the source system, so a figure can be traced back to the feed it came from.';

-- ---------------------------------------------------------------------------
-- 2. France item codes the master was missing
-- ---------------------------------------------------------------------------
-- Taken from the live France feed, where the codes are the bare product names. Only rows that
-- already exist in the master are touched, and only where the column is currently null, so this
-- cannot overwrite a code somebody set deliberately.
update public.product_code_master set code_france = 'H10'  where internal_sku = 'EBH10' and code_france is null;
update public.product_code_master set code_france = 'V2'   where internal_sku = 'V2'    and code_france is null;
update public.product_code_master set code_france = 'M1'   where internal_sku = 'M1'    and code_france is null;
update public.product_code_master set code_france = 'COMP' where internal_sku = 'COMP'  and code_france is null;
update public.product_code_master set code_france = 'FSCS' where internal_sku = 'FSCS'  and code_france is null;
update public.product_code_master set code_france = 'H8'   where internal_sku = 'EBH8'  and code_france is null;

-- ---------------------------------------------------------------------------
-- 3. Widen the depot and organisation lists, then extend the mapping
-- ---------------------------------------------------------------------------
-- product_depot_mapping carries three check constraints that hard-code the estate as USA, Canada
-- and Slovakia. They are kept, not dropped: the pairing check is genuinely useful (it stops a
-- France item code being filed under a UK depot). They are simply widened to the organisations
-- that now have a stock feed, and the pairs stay exhaustive.
alter table public.product_depot_mapping drop constraint if exists depot_org_consistency;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_depot_code_check;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_xero_org_check;

alter table public.product_depot_mapping
  add constraint product_depot_mapping_depot_code_check
  check (depot_code in ('US-BAL', 'US-SBD', 'CA-HAM', 'EB-SRO', 'GB-BSE', 'EU-FR', 'EB-GROUP', 'AU-SYD'));

alter table public.product_depot_mapping
  add constraint product_depot_mapping_xero_org_check
  check (xero_org in ('USA', 'CANADA', 'SLOVAKIA', 'UK', 'FRANCE', 'GROUP', 'AUSTRALIA'));

alter table public.product_depot_mapping
  add constraint depot_org_consistency
  check (
       (depot_code in ('US-BAL', 'US-SBD') and xero_org = 'USA')
    or (depot_code = 'CA-HAM'   and xero_org = 'CANADA')
    or (depot_code = 'EB-SRO'   and xero_org = 'SLOVAKIA')
    or (depot_code = 'GB-BSE'   and xero_org = 'UK')
    or (depot_code = 'EU-FR'    and xero_org = 'FRANCE')
    or (depot_code = 'EB-GROUP' and xero_org = 'GROUP')
    or (depot_code = 'AU-SYD'   and xero_org = 'AUSTRALIA')
  );

-- Australia is in the lists deliberately even though it has no stock today. Dean, 17 Sep:
-- "Australia is empty at the moment as we are building it up again." When it comes back, it needs
-- rows, not another migration.

-- The mapping itself is derived from product_code_master rather than invented: it already carries code_uk, code_france
-- and code_grp per product. The join is case-insensitive and trimmed because the France feed says
-- "Hooks" where the master says "HOOKS", which alone accounted for 1,056 unmapped units.
--
-- 🔴 hubspot_sku_code is set to internal_sku for these organisations, NOT to an NA-style SKU.
-- North America uses EBH9NA; there is no EBH9UK and inventing one would be worse than using the
-- master's own neutral spine. That leaves the Hub with two SKU vocabularies, which is a real
-- outstanding problem and a bigger job than this migration.
insert into public.product_depot_mapping
  (hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description, product_family, is_active)
select
  m.internal_sku,
  d.depot_code,
  d.xero_org,
  d.code,
  m.product_name,
  m.product_family,
  true
from public.product_code_master m
cross join lateral (values
  ('UK',     'GB-BSE',   nullif(trim(m.code_uk), '')),
  ('FRANCE', 'EU-FR',    nullif(trim(m.code_france), '')),
  ('GROUP',  'EB-GROUP', nullif(trim(m.code_grp), ''))
) as d(xero_org, depot_code, code)
where m.is_active
  and d.code is not null
  and m.internal_sku <> 'DELINFO'
  and not exists (
    select 1 from public.product_depot_mapping p
    where p.depot_code = d.depot_code
      and lower(p.xero_item_code) = lower(d.code)
  );

-- ---------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from public.product_depot_mapping where depot_code in ('GB-BSE', 'EU-FR', 'EB-GROUP');
  if n = 0 then
    raise exception 'no UK, France or Group mapping rows were created';
  end if;
  raise notice 'product_depot_mapping now holds % UK/France/Group rows', n;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'warehouse_stock_levels' and column_name = 'source'
  ) then
    raise exception 'warehouse_stock_levels.source is missing';
  end if;
end $$;
