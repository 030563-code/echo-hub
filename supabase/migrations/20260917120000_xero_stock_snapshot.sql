-- Xero stock snapshot for the organisations North America's sync does not cover.
--
-- Dean, 17 Sep 2026: "lets add the save to supabase nodes to Dave's UK, France,
-- and all the workflows where he does the daily stock reports", after the audit
-- found the Hub holds no stock figure at all for UK, France or Australia and
-- that those daily reports render per-SKU rows into an email and discard them.
--
-- 🔴 This is deliberately NOT eb_operations.inventory_snapshot. That table is
-- written by "North America Stock WF1" with a DELETE of the WHOLE table
-- (?id=gt.0, no region predicate) followed by an insert. A second writer using
-- the same pattern would wipe North America's rows on every run. Keeping the
-- other regions in their own table removes that blast radius entirely, and
-- lets this one be a real upsert instead of a daily truncate.
--
-- Unlike inventory_snapshot, which holds a single day because it is truncated,
-- this keeps one row per organisation, item and date, so it accumulates the
-- history the prediction work needs.
create table if not exists public.xero_stock_snapshot (
  id bigint generated always as identity primary key,
  -- 'UK', 'FRANCE', 'AUSTRALIA', 'SLOVAKIA', 'GROUP'. Free text rather than a
  -- check constraint: a new organisation must not need a migration to land.
  xero_org text not null,
  xero_item_code text not null,
  description text,
  qty_on_hand numeric not null default 0,
  total_cost_pool numeric,
  avg_unit_value numeric,
  -- Committed customer orders, where the source has them. UK reads them from
  -- MCS; France has no feed and sends null, which is not the same as zero.
  qty_committed numeric,
  qty_on_order numeric,
  -- 🔴 on_order means two different things across the source reports: UK nets
  -- QuantityReceived off the authorised purchase orders, France does not. The
  -- column would silently mix the two, so each row says which it is.
  on_order_basis text check (on_order_basis in ('outstanding', 'gross')),
  -- Resolved through public.product_depot_mapping where a mapping exists.
  depot_code text,
  product_family text,
  -- True when the source filtered to IsTrackedAsInventory. France does not, so
  -- its rows can include untracked items with no meaningful quantity.
  is_tracked boolean,
  snapshot_date date not null,
  -- Which workflow wrote the row, so a bad load can be found and removed.
  source text not null,
  synced_at timestamptz not null default now(),
  constraint xero_stock_snapshot_unique unique (xero_org, xero_item_code, snapshot_date)
);

comment on table public.xero_stock_snapshot is
  'Daily Xero tracked-inventory levels for the organisations outside North America. Upserted on (xero_org, xero_item_code, snapshot_date), so a re-run is a no-op and the table accumulates history. NOT eb_operations.inventory_snapshot, which is truncated whole on every North America run.';

create index if not exists xero_stock_snapshot_org_date
  on public.xero_stock_snapshot (xero_org, snapshot_date desc);
create index if not exists xero_stock_snapshot_item
  on public.xero_stock_snapshot (xero_item_code);

alter table public.xero_stock_snapshot enable row level security;

-- Writes are service-role only, like every other sync target. Reads are
-- confined to granted staff accounts by is_internal(), the same predicate the
-- factory-login migration put on the other 30 read policies; the manufacturer's
-- external login must never see depot or group stock.
drop policy if exists "hub: read xero_stock_snapshot" on public.xero_stock_snapshot;
create policy "hub: read xero_stock_snapshot"
  on public.xero_stock_snapshot for select to authenticated
  using ((select public.is_internal()));

-- 🔴 The project's default privileges hand `authenticated` ALL on every new
-- table, so the revoke has to name it explicitly. RLS does NOT cover TRUNCATE:
-- without this a signed-in session could empty the table whatever the read
-- policy says. Same hole as the anon TRUNCATE found on the mrp_* tables.
revoke all on public.xero_stock_snapshot from public, anon, authenticated;
grant select on public.xero_stock_snapshot to authenticated;
grant all on public.xero_stock_snapshot to service_role;
