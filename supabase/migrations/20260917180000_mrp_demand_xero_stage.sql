-- Staging for the Xero invoice-line backfill.
--
-- Rows land here first so the 2025 overlap can be checked against the curated tracking series
-- before anything is merged into mrp_demand_history. The raw item code, tracking option and
-- contact are kept alongside the classification, so a reclassification never needs a second pull
-- against Xero: the first pass classified on tracking options, which only came into use around
-- 2025, and the second read the item codes, where the suffix is a depot rather than a model
-- (H9BALT is an H9 at Baltimore). That second pass was pure SQL because of these columns.
create table if not exists public.mrp_demand_xero_stage (
  id bigint generated always as identity primary key,
  organisation text not null,
  channel text not null,
  event_date date not null,
  period_month date not null,
  product_model text not null,
  product_class text not null,
  quantity numeric not null,
  source_ref text not null,
  source_label text,
  invoice_number text,
  contact_name text,
  item_code text,
  tracking_option text,
  line_amount numeric,
  currency text,
  -- A month that came back with a full page of 100 invoices may have been truncated. Flagged
  -- rather than silently trusted; no month has tripped it so far.
  page_was_full boolean not null default false,
  loaded_at timestamptz not null default now(),
  unique (source_ref)
);

comment on table public.mrp_demand_xero_stage is
  'Raw Xero invoice barrier lines pulled by the n8n backfill (workflow PB2yeP5Z3oiE4pyk), 2020-06 onward, for EB-USA, EB-CANADA, EB-FRANCE and EB-GROUP. Staging only. Unmapped lines stay here rather than being guessed into a model.';

create index if not exists idx_mrp_demand_xero_stage_org_month
  on public.mrp_demand_xero_stage (organisation, period_month);

alter table public.mrp_demand_xero_stage enable row level security;

drop policy if exists "hub: read mrp_demand_xero_stage" on public.mrp_demand_xero_stage;
create policy "hub: read mrp_demand_xero_stage"
  on public.mrp_demand_xero_stage for select to authenticated
  using ((select public.is_internal()));

revoke all on public.mrp_demand_xero_stage from public, anon, authenticated;
grant select on public.mrp_demand_xero_stage to authenticated;
grant all on public.mrp_demand_xero_stage to service_role;
