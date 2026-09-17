-- The Stock Prediction Engine computes per organisation, and uses the deep history.
--
-- Dean, 17 Sep 2026: "Build everything", after the demand history from 2020 was loaded per
-- organisation into mrp_demand_history and the audit found the engine could not read any of it.
--
-- Two things were in the way. The demand read hard-filtered region in ('US','CA') and fetched
-- only 371 days, and the buffer tables were keyed on SKU alone, so there was nowhere to put a
-- second organisation's number even if it could be computed.
--
-- 🔴 Organisations still compute SEPARATELY. The contract written into migration
-- 20260808000300 says UK and Australia demand must never enter a North American ADU, and that
-- reasoning holds: the UK is hire-led and roughly an order of magnitude larger. This migration
-- does not pool them, it gives each its own row. That is the opposite of merging them.
--
-- The 17 profile rows that exist today were seeded from region in ('US','CA') and were treated by
-- the engine as one pooled North American market. They are stamped EB-USA here because that is
-- where the volume is; Canada gets its own rows the first time the engine runs with its history.

-- ---------------------------------------------------------------------------
-- 1. Buffer profiles become per organisation
-- ---------------------------------------------------------------------------
alter table public.mrp_buffer_profile
  add column if not exists organisation text not null default 'EB-USA';

comment on column public.mrp_buffer_profile.organisation is
  'The entities.code this buffer belongs to. Buffers are never pooled across organisations: a UK ADU and a US ADU are different numbers for the same SKU.';

-- The alias FK pointed at sku alone, which stops being unique the moment a second
-- organisation exists. It becomes composite so an alias resolves inside its own
-- organisation rather than silently reaching into another one's vocabulary.
alter table public.mrp_buffer_profile
  drop constraint if exists mrp_buffer_profile_alias_of_fkey;
alter table public.mrp_buffer_profile
  drop constraint if exists mrp_buffer_profile_pkey;
alter table public.mrp_buffer_profile
  add constraint mrp_buffer_profile_pkey primary key (organisation, sku);
alter table public.mrp_buffer_profile
  add constraint mrp_buffer_profile_alias_of_fkey
  foreign key (organisation, alias_of)
  references public.mrp_buffer_profile (organisation, sku);

-- ---------------------------------------------------------------------------
-- 2. Nightly status rows become per organisation
-- ---------------------------------------------------------------------------
alter table public.mrp_buffer_status_daily
  add column if not exists organisation text not null default 'EB-USA';

alter table public.mrp_buffer_status_daily
  drop constraint if exists mrp_buffer_status_daily_pkey;
alter table public.mrp_buffer_status_daily
  add constraint mrp_buffer_status_daily_pkey primary key (run_date, organisation, sku);

-- ---------------------------------------------------------------------------
-- 3. The statistics that make six years of history worth having
-- ---------------------------------------------------------------------------
-- ADU divides by a fixed 180 days and CoV uses 52 weeks, so a longer fetch window on its own
-- changes neither number. These columns are where the deep history actually lands.
--
-- Seasonality is deliberately absent and must stay absent: it was tested on the full history and
-- a seasonal index lost to a flat one twelfth in 13 of 13 hold-out backtests. What the deep
-- history does show is ORDER LUMPINESS, a single invoice being half or more of a month's units in
-- 31% of H9 months and 62% of Noise Defender months. That is a real, sizeable risk and it is what
-- these columns measure.
alter table public.mrp_buffer_profile
  add column if not exists deep_adu numeric,
  add column if not exists deep_cov numeric,
  add column if not exists deep_p95_order numeric,
  add column if not exists deep_max_order numeric,
  add column if not exists deep_months int,
  add column if not exists deep_from date;

comment on column public.mrp_buffer_profile.deep_adu is
  'Average daily usage over the whole loaded history, not the 180 day ADU window. For comparison against adu, never as a substitute.';
comment on column public.mrp_buffer_profile.deep_cov is
  'Coefficient of variation over the whole loaded history, monthly buckets.';
comment on column public.mrp_buffer_profile.deep_p95_order is
  '95th percentile of a single order line over the whole history. The red zone must cover at least this, or one ordinary large order empties the buffer.';
comment on column public.mrp_buffer_profile.deep_max_order is
  'Largest single order line ever seen. Context for the buyer, not a sizing input.';
comment on column public.mrp_buffer_profile.deep_months is
  'Count of distinct months with demand in the loaded history. Under 12 means any variability figure is guesswork.';
comment on column public.mrp_buffer_profile.deep_from is
  'First demand date in the loaded history for this organisation and SKU.';

-- ---------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n
  from information_schema.table_constraints
  where table_schema = 'public'
    and table_name = 'mrp_buffer_profile'
    and constraint_type = 'PRIMARY KEY';
  if n <> 1 then
    raise exception 'mrp_buffer_profile must have exactly one primary key, found %', n;
  end if;

  select count(*) into n
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'mrp_buffer_profile'
    and column_name in ('organisation', 'deep_adu', 'deep_cov', 'deep_p95_order', 'deep_max_order', 'deep_months', 'deep_from');
  if n <> 7 then
    raise exception 'expected 7 new profile columns, found %', n;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mrp_buffer_status_daily' and column_name = 'organisation'
  ) then
    raise exception 'mrp_buffer_status_daily.organisation is missing';
  end if;
end $$;
