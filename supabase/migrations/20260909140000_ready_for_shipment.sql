-- "Ready for shipment": the state between the goods existing and the freight
-- being booked.
--
-- Dean, 9 Sep 2026: "PO-01178 has moved to shipping but it should really be
-- Ready for shipment and then Shipping only once the spot id is confirmed and
-- the shipment is booked." The Hub had nowhere to say "these barriers exist and
-- are waiting for a truck", so an order jumped straight from being made to
-- being in transit, which it plainly was not.
--
-- It lands in BOTH machines on purpose:
--   * `status`, because it is a real thing that happened to the order. The SRO
--     leg used to sit on `in_manufacturing` for ever after Bamida had finished,
--     so the badge on the order said Manufacturing about barriers on a pallet.
--   * `lifecycle_stage`, because it is also a board column.
--
-- Additive only. Nothing is removed, no row is rewritten, and every existing
-- value stays legal, so this widens what is allowed and changes no data.
--
-- SAFE AS AN UPDATE: every notify trigger on purchase_orders is AFTER INSERT
-- (trg_notify_po_phase1, trg_notify_po_phase2), so moving a row to this status
-- fires no Slack message, no Xero purchase order and no email. Verified against
-- the deployed triggers, not the migration files.

-- 1. status
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN (
    'requested', 'approved', 'rejected', 'sro_evaluating',
    'fulfilling_from_stock', 'in_manufacturing',
    'ready_for_shipment',
    'shipped', 'delivered', 'cancelled'
  ));

-- 2. lifecycle_stage. The 2026-07-13 migration guarded its ADD CONSTRAINT with
-- an IF NOT EXISTS on the constraint name, so re-running that file would NOT
-- widen the list. Drop and recreate is the only thing that actually works here.
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_lifecycle_stage_chk;

ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_lifecycle_stage_chk
  CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN (
    'depot_group', 'group_sro', 'sro',
    'sent_manufacturing', 'manufacturing',
    'ready_for_shipment',
    'shipping'
  ));

-- 3. The RPC hardcodes the same list a second time and RAISEs on anything else,
-- so the constraint alone is not enough: without this, dragging a card to the
-- new column fails with "invalid stage".
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
    ('depot_group','group_sro','sro','sent_manufacturing','manufacturing','ready_for_shipment','shipping') THEN
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
