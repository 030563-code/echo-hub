-- ============================================================================
-- Echo Barrier Hub — Partial-delivery receipts + PO templates (SRO slice 4)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- PURELY ADDITIVE — two NEW tables + one capability. Nothing the live n8n PO
-- flow reads/writes is touched. No change to the PO status CHECK or numbering.
--
--   1. po_line_receipts — append-only batch receipts per PO line. A PO stays
--      "open" (approved) until every line's Σ received ≥ ordered; the
--      recordReceipt server action flips status → 'delivered' (service-role)
--      when complete. Receipts are qty-only (no price) and do NOT touch the
--      dummy warehouse_stock_levels.
--   2. po_templates — reusable recurring-order configs that pre-fill the raise
--      form. Read restricted to po.create holders (the lines jsonb carries
--      unit_price → keep it behind the buyer/cost gate).
--   3. po.receive capability — warehouse/receiving staff log deliveries.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. po_line_receipts
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.po_line_receipts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id           uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  po_line_id      uuid NOT NULL REFERENCES public.purchase_order_lines(id) ON DELETE CASCADE,
  qty_received    integer NOT NULL CHECK (qty_received > 0),
  batch_ref       text,
  note            text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  received_by_uid uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_line_receipts_po_id_idx   ON public.po_line_receipts (po_id);
CREATE INDEX IF NOT EXISTS po_line_receipts_line_id_idx ON public.po_line_receipts (po_line_id);

ALTER TABLE public.po_line_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.po_line_receipts FROM anon;
REVOKE UPDATE, DELETE ON public.po_line_receipts FROM authenticated;  -- append-only
GRANT SELECT, INSERT ON public.po_line_receipts TO authenticated;

-- Read: any authenticated user (matches purchase_orders read-all). Receipts are
-- qty-only, no price.
DROP POLICY IF EXISTS "hub: read receipts" ON public.po_line_receipts;
CREATE POLICY "hub: read receipts"
  ON public.po_line_receipts FOR SELECT TO authenticated
  USING (true);

-- Write: a po.receive holder logs a receipt stamped with their own uid.
DROP POLICY IF EXISTS "hub: record receipt" ON public.po_line_receipts;
CREATE POLICY "hub: record receipt"
  ON public.po_line_receipts FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.has_capability('po.receive'))
    AND received_by_uid = (SELECT auth.uid())
  );

-- ----------------------------------------------------------------------------
-- 2. po_templates
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.po_templates (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            text NOT NULL,
  from_entity     text,
  delivery_address text,
  notes           text,
  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_uid  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.po_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.po_templates FROM anon;
REVOKE UPDATE ON public.po_templates FROM authenticated;  -- delete + recreate, no in-place edit
GRANT SELECT, INSERT, DELETE ON public.po_templates TO authenticated;

-- Read restricted to raisers (lines jsonb carries unit_price → behind the buyer gate).
DROP POLICY IF EXISTS "hub: read templates" ON public.po_templates;
CREATE POLICY "hub: read templates"
  ON public.po_templates FOR SELECT TO authenticated
  USING ((SELECT public.has_capability('po.create')));

DROP POLICY IF EXISTS "hub: create template" ON public.po_templates;
CREATE POLICY "hub: create template"
  ON public.po_templates FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.has_capability('po.create'))
    AND created_by_uid = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "hub: delete template" ON public.po_templates;
CREATE POLICY "hub: delete template"
  ON public.po_templates FOR DELETE TO authenticated
  USING (
    (SELECT public.has_capability('po.create'))
    AND (created_by_uid = (SELECT auth.uid()) OR (SELECT public.is_super_admin()))
  );

-- ----------------------------------------------------------------------------
-- 3. po.receive capability + backfill
-- ----------------------------------------------------------------------------
INSERT INTO public.capabilities (key, module, description) VALUES
  ('po.receive', 'purchase-orders', 'Log deliveries/receipts against a purchase order (warehouse/receiving)')
ON CONFLICT (key) DO UPDATE
  SET module = EXCLUDED.module, description = EXCLUDED.description;

-- Backfill: warehouse staff (stock.edit holders) can also receive. Admins pass
-- via has_capability's 'admin' implication.
INSERT INTO public.user_capabilities (user_id, capability)
SELECT DISTINCT uc.user_id, 'po.receive'
FROM public.user_capabilities uc
WHERE uc.capability = 'stock.edit'
ON CONFLICT DO NOTHING;
