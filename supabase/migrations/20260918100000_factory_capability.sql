-- The factory sees what it can build and what we will need, and the Hub stops
-- calling a frozen feed "updated".
--
-- Bamida's CEO, 18 Sep 2026: "Minimum stock levels. It is crucial for the system
-- to be able to alert the warehouse when the stock of any material runs low.
-- Only you can configure this. We do not know the volume of orders or their
-- priorities." Dean's design the same day: beside the factory stock list, one
-- row per product with their estimated manufacturing capability (their API
-- stock through our BOM) and our projected requirement (accepted quotes, deal
-- probabilities, stock), and an alert when the requirement exceeds what they
-- can build.
--
-- Three things this file does:
--
-- 1. bamida_material_stock.last_changed_at. last_synced_at is stamped by the
--    sync RUN, so it read "today" on every row while the feed had not moved by
--    one unit since 6 August: 112 items, 46 snapshots, identical. A trigger
--    stamps last_changed_at only when a tracked value actually changes, so the
--    screen can say "unchanged since" and the alert can refuse to fire off a
--    stale number. Backfilled from the history table: the first capture of the
--    current unbroken run of identical values.
--
-- 2. The factory account may read the four MRP tables the product table is
--    built from. Row-limited on the status table to the SKUs that have a bill
--    of materials, so a supplier sees the products they build and nothing
--    else. None of the four carries a price.
--
-- 3. factory_stock_alerts, the memory that stops the low-stock email being a
--    daily nag: one row per distinct alert, sent once until the picture changes.
--    Service role only.

-- ---------------------------------------------------------------------------
-- 1. Data freshness, separate from sync freshness
-- ---------------------------------------------------------------------------
alter table public.bamida_material_stock
  add column if not exists last_changed_at timestamptz;

comment on column public.bamida_material_stock.last_changed_at is
  'When quantity, available_quantity or availability last actually changed. last_synced_at is when the sync last RAN; the feed served identical values from 6 Aug 2026 while that column said today.';

-- Backfill BEFORE the trigger exists, from the daily history: the earliest
-- capture of the run of identical values that ends at the current row.
with cur as (
  select ns_number, quantity, available_quantity
  from public.bamida_material_stock
),
last_diff as (
  select h.ns_number, max(h.captured_at) as changed_before
  from public.bamida_material_stock_history h
  join cur on cur.ns_number = h.ns_number
  where h.quantity is distinct from cur.quantity
     or h.available_quantity is distinct from cur.available_quantity
  group by h.ns_number
),
first_same as (
  select h.ns_number, min(h.captured_at) as since
  from public.bamida_material_stock_history h
  join cur on cur.ns_number = h.ns_number
  left join last_diff d on d.ns_number = h.ns_number
  where (d.changed_before is null or h.captured_at > d.changed_before)
    and h.quantity is not distinct from cur.quantity
    and h.available_quantity is not distinct from cur.available_quantity
  group by h.ns_number
)
update public.bamida_material_stock s
   set last_changed_at = coalesce(f.since, s.first_seen_at, s.last_synced_at)
  from first_same f
 where f.ns_number = s.ns_number;

update public.bamida_material_stock
   set last_changed_at = coalesce(first_seen_at, last_synced_at)
 where last_changed_at is null;

create or replace function public.bamida_stock_track_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.last_changed_at := coalesce(new.last_changed_at, new.last_synced_at, now());
  elsif new.quantity is distinct from old.quantity
     or new.available_quantity is distinct from old.available_quantity
     or new.availability is distinct from old.availability then
    new.last_changed_at := coalesce(new.last_synced_at, now());
  else
    -- Nothing tracked moved. Keep what we had, unless somebody is correcting
    -- the stamp on purpose.
    new.last_changed_at := coalesce(new.last_changed_at, old.last_changed_at);
  end if;
  return new;
end
$$;

comment on function public.bamida_stock_track_change() is
  'Stamps bamida_material_stock.last_changed_at only when a tracked value changes. The daily sync upserts every row every run, so without this the column would be as meaningless as last_synced_at.';

drop trigger if exists trg_bamida_stock_track_change on public.bamida_material_stock;
create trigger trg_bamida_stock_track_change
  before insert or update on public.bamida_material_stock
  for each row execute function public.bamida_stock_track_change();

-- ---------------------------------------------------------------------------
-- 2. What the factory may read for the product table
-- ---------------------------------------------------------------------------
alter policy "hub: read mrp_buffer_status_daily" on public.mrp_buffer_status_daily
  using (
    (select public.is_internal())
    or (
      (select public.has_capability('factory.view'))
      and sku in (select hub_sku from public.mrp_bom_sku_map)
    )
  );

alter policy "hub: read mrp_bom_product" on public.mrp_bom_product
  using ((select public.is_internal()) or (select public.has_capability('factory.view')));

alter policy "hub: read mrp_bom_component" on public.mrp_bom_component
  using ((select public.is_internal()) or (select public.has_capability('factory.view')));

alter policy "hub: read mrp_bom_sku_map" on public.mrp_bom_sku_map
  using ((select public.is_internal()) or (select public.has_capability('factory.view')));

-- ---------------------------------------------------------------------------
-- 3. Sent once until it changes
-- ---------------------------------------------------------------------------
create table if not exists public.factory_stock_alerts (
  id            uuid primary key default gen_random_uuid(),
  -- sha256 over the sorted (sku, short) and (ns_number, short) pairs, so the
  -- same picture two mornings running is one alert, and any change is a new one.
  fingerprint   text not null unique,
  first_sent_at timestamptz not null default now(),
  last_sent_at  timestamptz not null default now(),
  payload       jsonb not null
);

comment on table public.factory_stock_alerts is
  'The low-stock emails sent to the manufacturer, keyed on what they said. Written by /api/mrp/factory-alert with the service role; nothing else reads or writes it.';

alter table public.factory_stock_alerts enable row level security;
revoke all on public.factory_stock_alerts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The check that makes this file worth trusting
-- ---------------------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(tablename || '.' || policyname, ', ' order by tablename)
    into bad
  from pg_policies
  where schemaname = 'public'
    and tablename in ('mrp_buffer_status_daily', 'mrp_bom_product', 'mrp_bom_component', 'mrp_bom_sku_map')
    and cmd = 'SELECT'
    and qual not like '%factory.view%';
  if bad is not null then
    raise exception 'factory_capability: the factory still cannot read: %', bad;
  end if;

  if exists (select 1 from public.bamida_material_stock where last_changed_at is null) then
    raise exception 'factory_capability: last_changed_at backfill left nulls';
  end if;

  if has_table_privilege('authenticated', 'public.factory_stock_alerts', 'SELECT')
     or has_table_privilege('anon', 'public.factory_stock_alerts', 'SELECT') then
    raise exception 'factory_capability: factory_stock_alerts is readable from a browser';
  end if;
end $$;
