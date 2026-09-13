-- Materials on order: the rolls and infill Echo Barrier s.r.o. has bought and
-- not yet received. Juraj's stock-take sheet (11 Sep 2026) carries an
-- "ordered not delivered" column that had nowhere to go: 720 lm of PC 350 FR
-- black 2.1 m, 4,800 lm of PC 350 FR black 1.5 m, 800 lm of PC 350 FR blue.
-- Without it the materials board says the 1.5 m roll is at zero and stops
-- there, when a delivery is on its way.
--
-- One row per open purchase line. received_at is stamped when the goods land
-- and the count (or a receipt movement, later) takes over; the board shows only
-- rows with received_at null as "on order". Not a ledger: nothing here moves a
-- balance. Loaded by scripts/stock/load-material-orders.ts.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

create table public.material_orders (
  id              uuid primary key default gen_random_uuid(),
  warehouse_code  text not null,
  -- mrp_bom_map.component_code (PC350FR-UV21, PC350FR-UV15, ...)
  component_code  text not null,
  quantity        numeric(14,3) not null check (quantity > 0),
  unit            text,
  supplier        text,
  expected_at     date,
  note            text,
  received_at     timestamptz,
  created_by_uid  uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

comment on table public.material_orders is
  'Raw materials s.r.o. has ordered and not yet received. Shown as "on order" on the materials board while received_at is null. Not a ledger; nothing here moves a balance.';

create index material_orders_open_idx
  on public.material_orders (warehouse_code, component_code)
  where received_at is null;

alter table public.material_orders enable row level security;
revoke all on public.material_orders from public, anon, authenticated;
