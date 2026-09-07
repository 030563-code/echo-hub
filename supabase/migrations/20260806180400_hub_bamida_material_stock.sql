-- Live raw-material stock mirror from Bamida's facade API (data.bamida.sk).
--
-- Applied live to ops on 2026-08-06 via MCP (migration name
-- `create_bamida_material_stock`) while wiring the n8n sync; committed here
-- afterwards so the repo carries the schema. Content is identical to what was
-- applied — this file is the record, not a re-application.
--
-- Keyed on trimmed item_name because the facade's `sku` field currently returns
-- a constant 'SK' for every row (bug reported to Bamida); `bamida_sku` starts
-- carrying real card codes automatically once they fix it. Feed is raw
-- materials only (112 cards) — no finished goods yet.
--
-- Consumed by the MRP engine's materials gate via mrp_bom_map
-- (max_buildable = MIN over verified components of available_quantity/qty_per).

create table if not exists public.bamida_material_stock (
  id uuid primary key default gen_random_uuid(),
  item_name text not null unique,
  bamida_sku text,
  unit text,
  quantity numeric,
  available_quantity numeric,
  reserved numeric generated always as (quantity - available_quantity) stored,
  availability text,
  is_active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bamida_material_stock is 'Raw-material stock at Bamida (SRO manufacturing partner), synced from data.bamida.sk API. Materials only - no finished goods in the feed. available_quantity can be negative (over-committed reservations).';

create table if not exists public.bamida_material_stock_history (
  id uuid primary key default gen_random_uuid(),
  item_name text not null,
  quantity numeric,
  available_quantity numeric,
  availability text,
  captured_at timestamptz not null default now()
);

create index if not exists bamida_material_stock_history_item_time
  on public.bamida_material_stock_history (item_name, captured_at desc);

alter table public.bamida_material_stock enable row level security;
alter table public.bamida_material_stock_history enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'bamida_material_stock' and policyname = 'authenticated_read_bamida_stock') then
    create policy "authenticated_read_bamida_stock"
      on public.bamida_material_stock for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'bamida_material_stock_history' and policyname = 'authenticated_read_bamida_stock_history') then
    create policy "authenticated_read_bamida_stock_history"
      on public.bamida_material_stock_history for select to authenticated using (true);
  end if;
end $$;

-- No insert/update/delete policies: writes go through the n8n sync
-- (workflow Rsu0SnGdhwLWlPR8, daily 06:00 London) using the service role.
