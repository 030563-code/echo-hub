-- ============================================================================
-- Echo Barrier Hub — PO ↔ Cargo Partner shipment link (SRO slice 6, auto-detect)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- PURELY ADDITIVE — one NEW table. Stores the Cargo Partner SPOT ID + shipment
-- detail RESOLVED FROM the PO number (general reference), so the system detects
-- the SPOT ID itself instead of anyone typing it. One row per PO (upsert on
-- po_id). Written service-role only (the resolve/sync actions, after a
-- transport.view check); read-all for authenticated (shown on the PO board).
--
-- NB: the legacy `shipments` / `shipment_contents` tables use different PO
-- namespaces (zero overlap with purchase_orders.po_number), so this is a fresh
-- Hub-owned link rather than a join onto them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.po_shipments (
  po_id         uuid PRIMARY KEY REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  po_number     text NOT NULL,
  spot_id       text NOT NULL,
  container_ref text,
  eta           text,
  shipped_at    text,
  vessel        text,
  carrier       text,
  -- Live tracking status = the latest Cargo Partner event (per the API doc, status
  -- is derived from events[]; refreshed by the future scheduled sweep).
  last_event    text,
  last_event_at text,
  match_count   integer,
  resolved_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_shipments_spot_id_idx ON public.po_shipments (spot_id);

ALTER TABLE public.po_shipments ENABLE ROW LEVEL SECURITY;
-- Read-only for authenticated (writes go through service_role); nothing for anon.
REVOKE ALL ON public.po_shipments FROM anon, authenticated;
GRANT SELECT ON public.po_shipments TO authenticated;

DROP POLICY IF EXISTS "hub: read po shipments" ON public.po_shipments;
CREATE POLICY "hub: read po shipments"
  ON public.po_shipments FOR SELECT TO authenticated
  USING (true);
