-- ============================================================================
-- Echo Barrier Hub — over-receipt guard (slice 4 hardening)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- The recordReceipt action validates "qty ≤ outstanding" in the app, but that
-- check-then-insert is not atomic (two concurrent batches could each pass and
-- over-receive). This BEFORE INSERT trigger closes the race at the DB layer:
-- it locks the parent line row (FOR UPDATE) so concurrent receipts for the same
-- line serialise, then rejects any insert that would push Σ received past the
-- ordered quantity. PURELY ADDITIVE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.po_line_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ordered integer;
  already integer;
BEGIN
  -- Lock the parent line so concurrent receipts for it serialise.
  SELECT quantity INTO ordered
  FROM public.purchase_order_lines
  WHERE id = NEW.po_line_id
  FOR UPDATE;

  IF ordered IS NULL THEN
    RAISE EXCEPTION 'PO line % not found', NEW.po_line_id;
  END IF;

  SELECT COALESCE(sum(qty_received), 0) INTO already
  FROM public.po_line_receipts
  WHERE po_line_id = NEW.po_line_id;

  IF already + NEW.qty_received > ordered THEN
    RAISE EXCEPTION 'Receipt exceeds outstanding quantity for PO line % (ordered %, already received %, adding %)',
      NEW.po_line_id, ordered, already, NEW.qty_received;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger-only function — keep it out of the exposed PostgREST API.
REVOKE EXECUTE ON FUNCTION public.po_line_receipt_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS po_line_receipt_guard ON public.po_line_receipts;
CREATE TRIGGER po_line_receipt_guard
  BEFORE INSERT ON public.po_line_receipts
  FOR EACH ROW EXECUTE FUNCTION public.po_line_receipt_guard();
