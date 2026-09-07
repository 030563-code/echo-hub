-- The demand ledger's source check predates the demo dataset: it allows only
-- real capture paths (xero_invoice / hubspot_deal / mcs_invoice). The Andy
-- demo seeds 18 months of synthetic history that must be HONESTLY labeled —
-- 'demo_seed' keeps fabricated rows distinguishable from captured demand at
-- the row level (teardown key is source_ref like 'DEMO-%'). The engine reads
-- all sources for ADU/CoV, so no engine change accompanies this.
alter table public.mrp_demand_events
  drop constraint mrp_demand_events_source_check;

alter table public.mrp_demand_events
  add constraint mrp_demand_events_source_check
  check (source = any (array['xero_invoice'::text, 'hubspot_deal'::text, 'mcs_invoice'::text, 'demo_seed'::text]));
