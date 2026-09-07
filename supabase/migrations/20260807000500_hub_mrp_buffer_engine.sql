-- ============================================================================
-- MRP Task 8: DDMRP buffer engine — profiles, daily status, spike register,
-- DDS&OP log.
--
-- mrp_buffer_profile is the NA trigger engine's working set: one row per NA
-- SKU, seeded from the union of (distinct demand SKUs in US/CA rows of
-- mrp_demand_events) and (finished_sku like '%NA' in mrp_bom_map), minus two
-- non-SKU sentinels that leak in from demand parsing:
--   'NO_SKU_FOUND' (line-item parse-failure marker) and 'Transport' (freight
--   service line) — neither is a stockable product, so neither gets a buffer.
--
-- Two-vocabulary contract:
--   sku        = the NA engine vocabulary (EBH9NA, BUNNA, …) as it appears in
--                mrp_demand_events US/CA rows and mrp_bom_map.
--   family_sku = canonical product_code_master.internal_sku (EBH9, BUN, …) —
--                the join key to UK demand history, which is the statistical
--                donor for thin NA series.
-- family_sku is populated by deterministic EXACT-match tiers only (no fuzzy
-- mapping is ever invented):
--   1. po_product_catalog.sku -> internal_sku (the curated NA catalog; the
--      region code columns of product_code_master hold depot codes like
--      H9BALT/H9HAM, NOT the *NA vocabulary, so the catalog is the
--      authoritative NA->canonical map), validated to exist in
--      product_code_master;
--   2. product_code_master.internal_sku = sku (demand rows that already carry
--      canonical vocabulary, e.g. EBH10HERC);
--   3. trimmed exact match on product_code_master code columns
--      (code_uk/code_grp/code_usa_balt/code_usa_sb/code_canada) — catches
--      UK-vocabulary leaks like 01-EBH9.
-- Anything unmatched stays family_sku null (no UK donor) and is reported.
--
-- DLT seed (approved design): mfg 45 (TBC Bamida) + ocean 21 + customs 9 = 75
-- days; lt_factor 0.25 (long-lead); var_factor left null until measured CoV
-- lands (<1 -> 0.4, 1-2 -> 0.6, >2 -> 1.0).
--
-- Write path is service-role only (nightly engine / DDS&OP admin UI) — no
-- authenticated write policies, matching the other mrp_* tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Buffer profiles (the engine's working set)
-- ---------------------------------------------------------------------------
create table public.mrp_buffer_profile (
  sku          text primary key,               -- NA engine vocabulary
  sku_class    text not null default 'slow' check (sku_class in ('core','slow')),
  family_sku   text,                           -- canonical internal_sku (UK-donor join key), null = no donor
  adu          numeric,                        -- average daily usage, computed nightly when adu_source='auto'
  adu_source   text not null default 'auto' check (adu_source in ('auto','manual')),
  cov          numeric,                        -- coefficient of variation of demand
  dlt_days     int not null default 75,        -- decoupled lead time = mfg + ocean + customs
  mfg_lt       int not null default 45,        -- Bamida manufacturing leg (TBC)
  ocean_lt     int not null default 21,
  customs_lt   int not null default 9,
  lt_factor    numeric not null default 0.25,  -- long-lead class
  var_factor   numeric,                        -- from measured CoV: <1 -> 0.4, 1-2 -> 0.6, >2 -> 1.0
  moq          int not null default 0,
  container_qty int,
  cbm_per_unit numeric,
  seeded       boolean not null default false, -- false until the nightly engine first computes adu/cov/zones
  updated_at   timestamptz not null default now()
);

comment on table public.mrp_buffer_profile is
  'DDMRP buffer profiles — the NA trigger engine''s working set. Two-vocabulary '
  'contract: sku is the NA engine vocabulary (EBH9NA, BUNNA, … as in '
  'mrp_demand_events US/CA rows and mrp_bom_map); family_sku is the canonical '
  'product_code_master.internal_sku used as the join key to UK demand history '
  '(the statistical donor for thin NA series) — null means no donor. Buffer '
  'zones recompute nightly from adu/cov while adu_source=''auto''; manual '
  'overrides are set at DDS&OP by flipping adu_source=''manual'' (the nightly '
  'engine must then leave adu alone).';

comment on column public.mrp_buffer_profile.family_sku is
  'Canonical internal_sku, populated at seed time by exact-match tiers only: '
  'po_product_catalog.sku->internal_sku, then '
  'product_code_master.internal_sku=sku, then trimmed exact match on '
  'product_code_master code columns. Never fuzzy-matched; null = unmatched.';

-- ---------------------------------------------------------------------------
-- 2. Daily buffer status (one row per engine run per SKU)
-- ---------------------------------------------------------------------------
create table public.mrp_buffer_status_daily (
  run_date         date not null,
  sku              text not null,
  on_hand          int,
  in_transit       int,
  on_order         int,
  firm_demand      numeric,
  qualified_spikes numeric,
  nfp              numeric,               -- net flow position
  projected_nfp    numeric,
  red              int,
  yellow_top       int,
  green_top        int,
  zone             text check (zone in ('red','yellow','green')),
  action_qty       int,
  max_buildable    int,                   -- null = capacity unknown (unverified BOM)
  blocked_by_materials boolean not null default false,
  p_stockout       numeric,
  p_stockout_ci    numeric,
  data_grade       text,
  flags            jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  primary key (run_date, sku)
);

-- ---------------------------------------------------------------------------
-- 3. Spike register (order-spike qualification per run/deal/SKU)
-- ---------------------------------------------------------------------------
create table public.mrp_spike_register (
  run_date  date not null,
  deal_id   text not null,
  sku       text not null,
  qty       numeric,
  due_date  date,
  weight    numeric,
  qualified boolean,
  primary key (run_date, deal_id, sku)
);

-- ---------------------------------------------------------------------------
-- 4. DDS&OP decision log
-- ---------------------------------------------------------------------------
create table public.mrp_ddsop_log (
  id           uuid primary key default gen_random_uuid(),
  meeting_date date not null,
  decisions    jsonb not null,
  logged_by    text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. Carried requirement: document the composite 'door' leg
-- ---------------------------------------------------------------------------
comment on column public.mrp_lead_time_actuals.leg is
  '''mfg'' | ''ocean'' | ''door''. NOTE: ''door'' observations are COMPOSITE '
  'port-to-door spans covering ocean + customs + inland + receipt-logging '
  'delay. Any DLT recalibration from actuals must therefore use '
  'DLT = mfg + door (door REPLACES ocean+customs) — summing mfg + ocean + door '
  'double-counts the ocean leg.';

-- ---------------------------------------------------------------------------
-- 6. RLS — read for authenticated, writes service-role only
-- ---------------------------------------------------------------------------
alter table public.mrp_buffer_profile      enable row level security;
alter table public.mrp_buffer_status_daily enable row level security;
alter table public.mrp_spike_register      enable row level security;
alter table public.mrp_ddsop_log           enable row level security;

create policy "hub: read mrp_buffer_profile"
  on public.mrp_buffer_profile for select to authenticated
  using (true);

create policy "hub: read mrp_buffer_status_daily"
  on public.mrp_buffer_status_daily for select to authenticated
  using (true);

create policy "hub: read mrp_spike_register"
  on public.mrp_spike_register for select to authenticated
  using (true);

create policy "hub: read mrp_ddsop_log"
  on public.mrp_ddsop_log for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 7. Seed: one profile row per NA SKU in the demand/BOM universe
-- ---------------------------------------------------------------------------
with na_universe as (
  select distinct sku from public.mrp_demand_events where region in ('US','CA')
  union
  select distinct finished_sku from public.mrp_bom_map where finished_sku like '%NA'
),
seed as (
  -- exclude non-SKU sentinels: parse-failure marker + freight service line
  select sku from na_universe
  where sku not in ('NO_SKU_FOUND', 'Transport')
)
insert into public.mrp_buffer_profile (sku, family_sku)
select
  s.sku,
  coalesce(cat.internal_sku, pcm_direct.internal_sku, pcm_code.internal_sku)
from seed s
left join lateral (
  -- tier 1: curated NA catalog, validated against product_code_master
  select c.internal_sku
  from public.po_product_catalog c
  where c.sku = s.sku
    and exists (select 1 from public.product_code_master m
                where m.internal_sku = c.internal_sku)
  order by c.internal_sku
  limit 1
) cat on true
left join lateral (
  -- tier 2: demand row already carries canonical vocabulary
  select m.internal_sku
  from public.product_code_master m
  where m.internal_sku = s.sku
  limit 1
) pcm_direct on true
left join lateral (
  -- tier 3: exact (trimmed) match on region code columns
  select m.internal_sku
  from public.product_code_master m
  where s.sku in (trim(m.code_uk), trim(m.code_grp), trim(m.code_usa_balt),
                  trim(m.code_usa_sb), trim(m.code_canada))
  order by m.internal_sku
  limit 1
) pcm_code on true;
