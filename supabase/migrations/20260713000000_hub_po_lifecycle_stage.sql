-- Manufacturing/lifecycle kanban stage for the PO board.
--
-- DEMO SCHEME — the final column set is to be confirmed with Juraj + Dave.
-- Columns (ordered): Depot -> Group -> S.R.O -> Sent to manufacturing ->
--                    Manufacturing in progress -> Shipping.
--
-- Additive + NULLABLE: when null the board derives the stage from leg+status, so
-- existing POs place sensibly with no backfill. Dragging a card persists an
-- explicit stage here. This is a PRESENTATION layer over the PO -- it deliberately
-- does NOT touch the `status` machine (no triggers / no invoice-lifecycle
-- side-effects), so it is safe to move cards freely in the demo.

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS lifecycle_stage text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_lifecycle_stage_chk'
  ) THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_lifecycle_stage_chk
      CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN
        ('depot_group','group_sro','sro','sent_manufacturing','manufacturing','shipping'));
  END IF;
END $$;

-- Authorized stage move. SECURITY DEFINER so it can write without widening the
-- narrow "approve PO" UPDATE policy; gated on po.approve OR po.receive (admin /
-- super-admin imply both via has_capability). Never anon. Mirrors the Hub's
-- server-authz posture (see has_capability in the capability model migration).
CREATE OR REPLACE FUNCTION public.set_po_lifecycle_stage(p_po_id uuid, p_stage text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT (public.has_capability('po.approve') OR public.has_capability('po.receive')) THEN
    RAISE EXCEPTION 'forbidden: requires po.approve or po.receive';
  END IF;

  IF p_stage IS NULL OR p_stage NOT IN
    ('depot_group','group_sro','sro','sent_manufacturing','manufacturing','shipping') THEN
    RAISE EXCEPTION 'invalid stage: %', p_stage;
  END IF;

  UPDATE public.purchase_orders
     SET lifecycle_stage = p_stage,
         updated_at = now()
   WHERE id = p_po_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase order not found: %', p_po_id;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.set_po_lifecycle_stage(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_po_lifecycle_stage(uuid, text) TO authenticated;
