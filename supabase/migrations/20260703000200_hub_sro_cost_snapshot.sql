-- Freeze the SRO/BOM cost at approval. Once an EB_GROUP_TO_SRO PO is approved,
-- its exploded BOM cost is FROZEN onto the row (authoritative — it drives the
-- record and, later, the Xero PO) so it no longer floats when a material price is
-- edited afterwards. loadSroPoBoms shows the frozen snapshot for snapshotted POs
-- and still live-explodes any older approved PO that predates this column.
--   cost_snapshot        = the full exploded SroPoBom (lines + components + totals)
--   sro_cost_snapshot_eur = the frozen SRO total (for quick queries/reporting)
--   cost_snapshot_at     = when it was frozen
alter table public.purchase_orders
  add column if not exists sro_cost_snapshot_eur numeric,
  add column if not exists cost_snapshot jsonb,
  add column if not exists cost_snapshot_at timestamptz;
