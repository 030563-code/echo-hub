-- ============================================================================
-- MRP Task 4: lead-time actuals — observed per-leg transit durations.
--
-- Fed by recordReceipt: when a depot PO flips to 'delivered', its linked
-- shipment_contents rows (po_id) are drained to 'delivered' and each row with
-- a usable shipped_at yields one 'door' observation (shipped -> delivered,
-- fractional days). 'mfg' and 'ocean' legs are reserved for later writers.
-- Write path is service-role only (no authenticated write policies).
-- ============================================================================
create table public.mrp_lead_time_actuals (
  id uuid primary key default gen_random_uuid(),
  po_id uuid,
  spot_id text,
  leg text not null check (leg in ('mfg','ocean','door')),
  days numeric not null check (days > 0 and days < 365),
  observed_at timestamptz not null default now()
);

create index mrp_lead_time_actuals_leg_observed
  on public.mrp_lead_time_actuals (leg, observed_at desc);

alter table public.mrp_lead_time_actuals enable row level security;

create policy "hub: read mrp_lead_time_actuals"
  on public.mrp_lead_time_actuals for select to authenticated
  using (true);

-- ============================================================================
-- Backfill: link the legacy in-transit shipment_contents rows to their Hub POs
-- so the receipt-time drain can find them. shipment_contents.po_reference is
-- free text from the legacy flow (EBG25xxx / null) and matches no Hub PO —
-- the po_id uuid must be mapped by hand.
--
-- TODO(Dave): legacy shipment↔PO mapping — uncomment + fill po_id per row:
--
--   id                                   | container_ref | sku         | qty | po_reference
--   -------------------------------------+---------------+-------------+-----+-------------
--   33a395f7-5137-45ff-a793-1ae84748630c | FANU3080006   | EBH9NA      | 560 | EBG25099
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '33a395f7-5137-45ff-a793-1ae84748630c';
--   3856c744-a6c5-4a06-af76-c37ff6571516 | TIIU5900078   | CCSNA       |   3 | (null)
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '3856c744-a6c5-4a06-af76-c37ff6571516';
--   559e9235-9537-48fe-b322-d080dadabf07 | TIIU5900078   | EBVFKNA     | 150 | (null)
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '559e9235-9537-48fe-b322-d080dadabf07';
--   6051cb79-be5e-48f5-bae6-c68eca0221c5 | CMAU4783188   | EBH9XNA     | 400 | EBG25111
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '6051cb79-be5e-48f5-bae6-c68eca0221c5';
--   6fed0713-9d34-4a70-8cbd-476deb3d4802 | CMAU6783741   | EBH9XNA     | 400 | EBG25112
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '6fed0713-9d34-4a70-8cbd-476deb3d4802';
--   824ef507-7e08-4d5e-9427-309d61f65498 | BEAU4067822   | EBH10HERCNA | 280 | EBG25119
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '824ef507-7e08-4d5e-9427-309d61f65498';
--   8f9ce179-cf4e-4f75-b6e5-bc42e7b841f0 | BEAU4067822   | EBH9NA      | 280 | EBG26002
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '8f9ce179-cf4e-4f75-b6e5-bc42e7b841f0';
--   98a21ffb-0bac-4d89-b47e-0aeb9c82857d | TIIU5900078   | FSCNA       |   3 | (null)
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '98a21ffb-0bac-4d89-b47e-0aeb9c82857d';
--   9f0d9bc2-52b3-4608-aad2-5260e0c43b65 | ONEU6581573   | EBH9NA      | 560 | EBG25089
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = '9f0d9bc2-52b3-4608-aad2-5260e0c43b65';
--   c5c41c35-28fe-4604-9e25-5ac2bd95cdf8 | TIIU5900078   | EBH8NA      | 120 | (null)
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = 'c5c41c35-28fe-4604-9e25-5ac2bd95cdf8';
--   eb3370d9-d9e4-439b-9ea2-fc289927e34a | TCLU7829814   | EBH9NA      | 560 | EBG25103
-- update shipment_contents set po_id = '<PO-UUID-TBD>' where id = 'eb3370d9-d9e4-439b-9ea2-fc289927e34a';
