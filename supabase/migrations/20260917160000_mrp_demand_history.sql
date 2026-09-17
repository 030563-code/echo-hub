-- Demand history from the month the H10 started being invoiced, split by organisation.
--
-- Dean, 17 Sep 2026: "We will only be looking at the data starting from when the
-- H10 started being invoiced which seems to be 2020-06-09. and we will use all
-- data from them across all organisations and also split by organisation as this
-- is very important for the Stock Prediction Engine".
--
-- The cut is stored as 2020-06-01 rather than 2020-06-09. No invoice anywhere
-- falls on the 9th; the genuine first H10 line is Australia 31 May 2020 (8 units,
-- EBHS, descr "Echo Barrier H Series - H10") and the UK's first is 15 June 2020.
-- A mid-month cut would leave June 2020 a part-month in every rate that divides
-- by months, so the window starts at the first of the month in which the H10
-- began trading. The single 31 May 2020 Australian line sits outside it.
--
-- 🔴 This is NOT mrp_demand_events and must not be merged into it. That table is
-- the engine's live feed, written once by scripts/backfill-mcs-demand.ts on
-- 7 August 2026 and never since, and an audit on 17 Sep 2026 found it carries:
--   * 618 intercompany units stamped region='UK' as if they were customer demand
--   * all 3,792 Australian sale units stamped sku='EBH9' on no evidence at all
--     (98.6% of Australian H-series volume names no model anywhere in the ledger)
--   * the model-blind code EBHS mapped unconditionally to EBH9 (backfill line 88),
--     5,942 in-window units of which only 588 carry a descr naming an H9
--   * negative contra lines booked as positive demand, and a 356-unit order
--     booked twice (invoices UK-15221 and UK-15222)
--   * bungees (25,415 units), hooks and freight in the same quantity column as
--     barriers, so no total across it means anything
--   * itype 'X' excluded at source, so 3,973 genuine customer barrier units are
--     missing from the UK series entirely
-- Correcting that table in place would rewrite the only record of what the
-- engine has been reading. This one is built alongside it so the two can be
-- compared before anything is cut over.
--
-- Grain is deliberately mixed and the `grain` column says which is which:
-- 'line' for the ledgers that carry an invoice date, 'month' for the Xero
-- tracking-category series, which exists only as a monthly total per entity.
create table if not exists public.mrp_demand_history (
  id bigint generated always as identity primary key,

  -- An entities.code value: EB-UK, EB-AUSTRALIA, EB-SRO, EB-GROUP, EB-USA,
  -- EB-CANADA, EB-FRANCE. Not a check constraint, so a new organisation does
  -- not need a migration, but it is meant to hold a real entity code.
  organisation text not null,

  -- 'customer'    an end customer, including distributors such as Bull Barrier
  -- 'intercompany' one Echo Barrier company invoicing another. This is demand on
  --                the factory, not demand in a market, and the two must never
  --                be summed into one series.
  channel text not null check (channel in ('customer', 'intercompany')),

  event_date date not null,
  -- First of the month containing event_date. For grain='month' rows this is
  -- the only real date and event_date repeats it.
  period_month date not null,
  grain text not null check (grain in ('line', 'month')),

  -- H9, H8, H10, H10Japan, H9X, H9Mini, HT3.5, EU3.5, V1, V2, M1, PB3,
  -- NoiseDefender, NoiseDefenderTriple, CSFullSize, CSCompact, GenExtension,
  -- HERAS, Pedestrian, BNM, dB-RS, dB-RT, H1, H2, H3, H4, and the honest
  -- H-SERIES-UNSPECIFIED for volume that names no model anywhere in its source.
  product_model text not null,

  -- 'BARRIER'          a finished unit sold or transferred as new
  -- 'BARRIER_EX_FLEET' a hire unit sold off, or a loss or damage recharge. Real
  --                    revenue, but it consumes no manufacturing capacity, so it
  --                    is carried and flagged rather than dropped.
  product_class text not null check (product_class in ('BARRIER', 'BARRIER_EX_FLEET')),

  quantity numeric not null,

  -- 🔴 Set where the same physical units are provably booked twice in the source
  -- (a bulk line beside its own serial lines, or an order invoiced twice). Any
  -- series built from this table must exclude these or it double counts.
  is_suspected_duplicate boolean not null default false,

  -- 'mcs_uk', 'mcs_oz', 'sro_sales_ledger', 'xero_tracking'.
  source text not null,
  -- Unique within source, so a reload is an upsert rather than a second copy.
  source_ref text not null,
  -- The raw descr, item code or tracking option the row was classified from, so
  -- a disputed classification can be argued from the original words.
  source_label text,

  loaded_at timestamptz not null default now(),

  unique (source, source_ref)
);

comment on table public.mrp_demand_history is
  'Barrier demand from 2020-06-01, split by organisation and channel. Built 17 Sep 2026 alongside mrp_demand_events, which it does not replace. Barrier units only: accessories, hire rebills, transport and service lines are excluded at load, so quantity is always a count of barriers.';

create index if not exists idx_mrp_demand_history_org_month
  on public.mrp_demand_history (organisation, period_month);
create index if not exists idx_mrp_demand_history_model_date
  on public.mrp_demand_history (product_model, event_date);
create index if not exists idx_mrp_demand_history_channel
  on public.mrp_demand_history (channel, product_class);

alter table public.mrp_demand_history enable row level security;

-- Reads are confined to granted staff accounts by is_internal(), the same
-- predicate the factory-login migration put on the other read policies. The
-- manufacturer's external login must never see group demand.
drop policy if exists "hub: read mrp_demand_history" on public.mrp_demand_history;
create policy "hub: read mrp_demand_history"
  on public.mrp_demand_history for select to authenticated
  using ((select public.is_internal()));

-- 🔴 The project's default privileges hand `authenticated` ALL on every new
-- table, so the revoke has to name it explicitly. RLS does NOT cover TRUNCATE:
-- without this a signed-in session could empty the table whatever the read
-- policy says.
revoke all on public.mrp_demand_history from public, anon, authenticated;
grant select on public.mrp_demand_history to authenticated;
grant all on public.mrp_demand_history to service_role;
