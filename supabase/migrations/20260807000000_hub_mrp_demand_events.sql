-- Unified demand ledger for the MRP engine. One row = one realized demand event
-- (invoice line or closed-won deal line), dated by the COMMERCIAL date, never
-- updated_at. Hire (MCS itype F) is fleet utilization and must never land here.
create table public.mrp_demand_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  sku text not null,
  qty numeric not null check (qty > 0),
  region text not null check (region in ('US','CA','UK','OZ','FR','OTHER')),
  source text not null check (source in ('xero_invoice','hubspot_deal','mcs_invoice')),
  source_ref text not null,          -- invoice id / deal id / mcs docnum
  created_at timestamptz not null default now(),
  unique (source, source_ref, sku)   -- idempotent re-backfill
);
create index mrp_demand_events_sku_date on public.mrp_demand_events (sku, event_date desc);
alter table public.mrp_demand_events enable row level security;
create policy "authenticated_read_demand_events" on public.mrp_demand_events
  for select to authenticated using (true);

-- ============================================================================
-- Backfill 1: Xero invoices (invoices_registry).
--
-- SCHEMA REALITY (verified 2026-08-07 against live korylyniwsqtsvzuzydg):
--   * invoices_registry is HEADER-ONLY — it has NO line-items column. Its
--     columns are hubspot_deal_id (text, PK), invoice_number, company_name,
--     total_amount, currency_code, due_date, xero_invoice_id, created_at,
--     updated_at. SKU-level detail is only reachable through the linked deal:
--     invoices_registry.hubspot_deal_id -> deals_registry.hubspot_deal_id
--     -> deals_registry.line_items_raw (jsonb array). 69 of 171 invoices join
--     a deal, and all 69 joined deals carry non-empty line_items_raw; the
--     other 102 invoices have no SKU detail anywhere and therefore cannot
--     produce demand rows.
--   * There is NO invoice_date column. due_date is the only commercial date
--     on the invoice (never null); created_at is the registry-ingestion
--     timestamp, so due_date is used as event_date.
--   * line_items_raw elements come in two generations of shape (snake_case
--     and camelCase); both use the key "quantity" (verified 310/310 elements,
--     all positive numeric) and "sku" (present + non-empty on 297/310; the
--     rest are skipped per plan).
--   * Two xero_invoice_ids are registered twice (one row keyed by the HubSpot
--     deal id, one by the invoice number, e.g. 'EB1850'); only the
--     deal-id-keyed row joins a deal, and rows are aggregated per
--     (xero_invoice_id, sku) with sum(qty), so duplicates cannot double-count
--     and repeated SKUs within one invoice are not silently dropped by the
--     unique constraint.
--
-- Region from currency_code per plan: USD->US, CAD->CA, GBP->UK, else OTHER
-- (live values: USD 100, GBP 36, EUR 16, CAD 14, AED 5).
-- ============================================================================
insert into public.mrp_demand_events (event_date, sku, qty, region, source, source_ref)
select
  i.due_date                          as event_date,
  nullif(trim(e->>'sku'), '')         as sku,
  sum((e->>'quantity')::numeric)      as qty,
  case i.currency_code
    when 'USD' then 'US'
    when 'CAD' then 'CA'
    when 'GBP' then 'UK'
    else 'OTHER'
  end                                 as region,
  'xero_invoice'                      as source,
  i.xero_invoice_id                   as source_ref
from public.invoices_registry i
join public.deals_registry d on d.hubspot_deal_id = i.hubspot_deal_id
cross join lateral jsonb_array_elements(coalesce(d.line_items_raw, '[]'::jsonb)) e
where nullif(trim(e->>'sku'), '') is not null
  and (e->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
  and (e->>'quantity')::numeric > 0
group by i.xero_invoice_id, i.due_date, i.currency_code, nullif(trim(e->>'sku'), '')
on conflict (source, source_ref, sku) do nothing;

-- ============================================================================
-- Backfill 2: closed-won HubSpot deals (deals_registry, deal_status='closedwon').
--
-- SCHEMA REALITY (verified 2026-08-07):
--   * deals_registry has NO closed_at / close-date column (only created_at
--     and updated_at). updated_at is banned by design (it moves on any
--     touch), so created_at::date is used as event_date — it is the registry
--     ingestion date, the best available proxy for the commercial close date.
--   * There is NO depot_region column; depot_code exists (live values:
--     US-SBD, US-BAL, CA-HAM, EU-France, EU-Slovakia; often null). Region is
--     derived: depot prefix first (US-* -> US, CA-* -> CA, EU-France -> FR,
--     other EU-* -> OTHER), then currency (CAD -> CA, GBP -> UK), else the
--     plan's US default. No UK/OZ depot codes exist yet.
--   * hubspot_deal_id is unique across deals_registry -> clean source_ref.
--   * Only 1 of 488 closed-won deals has non-empty line_items_raw (deal
--     50879528572, USD, null depot -> US) — expected per the audit, not a
--     data bug. That deal has no invoices_registry row, so there is no
--     cross-source double-count in this backfill.
--   * Grouping by d.id (PK) + sku; qty summed per (deal, sku) for the same
--     no-silent-drop reason as backfill 1.
-- ============================================================================
insert into public.mrp_demand_events (event_date, sku, qty, region, source, source_ref)
select
  d.created_at::date                  as event_date,
  nullif(trim(e->>'sku'), '')         as sku,
  sum((e->>'quantity')::numeric)      as qty,
  case
    when d.depot_code like 'US-%'     then 'US'
    when d.depot_code like 'CA-%'     then 'CA'
    when d.depot_code = 'EU-France'   then 'FR'
    when d.depot_code like 'EU-%'     then 'OTHER'
    when d.currency = 'CAD'           then 'CA'
    when d.currency = 'GBP'           then 'UK'
    else 'US'
  end                                 as region,
  'hubspot_deal'                      as source,
  d.hubspot_deal_id                   as source_ref
from public.deals_registry d
cross join lateral jsonb_array_elements(coalesce(d.line_items_raw, '[]'::jsonb)) e
where d.deal_status = 'closedwon'
  and nullif(trim(e->>'sku'), '') is not null
  and (e->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
  and (e->>'quantity')::numeric > 0
group by d.id, nullif(trim(e->>'sku'), '')
on conflict (source, source_ref, sku) do nothing;
