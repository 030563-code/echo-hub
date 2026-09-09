-- The evidence behind the bills of materials: one Bamida delivery note as it
-- applies to one product, and every line it carried.
--
-- mrp_bom_component holds the CURRENT best estimate, one row per component. It
-- cannot answer "where did 2.85 m2 come from", cannot hold a second observation
-- of the same product, and its basis check forbids the per-order lines that
-- scale with neither units nor pallets. This table holds all of that, so the
-- next delivery note is a diff against the last one instead of another
-- derivation from scratch.

create table if not exists public.mrp_bom_observation (
  id            uuid primary key default gen_random_uuid(),
  fg_code       text        not null,
  fg_label      text        not null,
  source_doc    text        not null,
  source_date   date,
  source_po     text,
  batch_size    numeric     not null check (batch_size > 0),
  pallet_count  numeric,
  -- One note pins the pallet size only to a range, because ceil() hides the
  -- divisor. Both ends are kept so a later note can narrow it.
  pallet_size_min integer,
  pallet_size_max integer,
  warnings      text[]      not null default '{}',
  created_at    timestamptz not null default now(),
  unique (fg_code, source_doc)
);

create table if not exists public.mrp_bom_observation_line (
  id             uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.mrp_bom_observation (id) on delete cascade,
  component_code text not null,
  component_desc text not null,
  qty            numeric not null check (qty >= 0),
  unit           text not null,
  -- per_order carries lines that scale with neither units nor pallets
  -- (ratchet straps counted against the whole order). mrp_bom_component
  -- cannot hold them, which is one reason this table exists.
  basis          text not null check (basis in ('per_unit','per_pallet','per_order')),
  line_type      text not null check (line_type in ('material','operation','intermediate')),
  raw_qty        numeric not null,
  in_stock_feed  boolean not null,
  unique (observation_id, component_code, basis)
);

create index if not exists mrp_bom_observation_fg_idx on public.mrp_bom_observation (fg_code);
create index if not exists mrp_bom_observation_line_code_idx on public.mrp_bom_observation_line (component_code);

comment on table public.mrp_bom_observation is
  'One Bamida delivery note as it applies to one product: what a single batch actually consumed. The evidence behind mrp_bom_component, kept so a later note can be diffed against an earlier one instead of re-derived.';
comment on column public.mrp_bom_observation.pallet_size_min is
  'A batch of 560 in 8 bags proves the pallet holds 70..79, not exactly 70. Intersecting several notes narrows it.';

-- Served by the app, never by PostgREST. This project grants authenticated
-- TRUNCATE on every new table in public by default, and RLS does not restrain
-- TRUNCATE, so the grants are revoked outright.
alter table public.mrp_bom_observation enable row level security;
alter table public.mrp_bom_observation_line enable row level security;
revoke all on public.mrp_bom_observation from public, anon, authenticated;
revoke all on public.mrp_bom_observation_line from public, anon, authenticated;

