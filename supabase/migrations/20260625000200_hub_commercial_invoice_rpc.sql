-- ============================================================================
-- Echo Barrier Hub — atomic create_commercial_invoice RPC (review fix H1/H2).
-- Target: ops korylyniwsqtsvzuzydg. ADDITIVE (new function; drops the now-unused
-- get_next_commercial_invoice_id from the prior migration — nothing references it).
--
-- Allocates the EBGS number AND writes the header + lines in ONE transaction, so a
-- line-insert failure rolls the whole thing back (no orphaned header with totals
-- but no lines). service_role-only (the gated server action). NB: the EBGS
-- sequence can still gap on a rolled-back attempt — that's inherent to Postgres
-- sequences and consistent with the quotes series; uniqueness is guaranteed.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_next_commercial_invoice_id();

CREATE OR REPLACE FUNCTION public.create_commercial_invoice(p_header jsonb, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number text;
  v_id     uuid;
BEGIN
  v_number := 'EBGS' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.commercial_invoice_seq')::text, 5, '0');

  INSERT INTO public.commercial_invoices (
    invoice_number, leg, seller_entity_code, buyer_entity_code,
    shipment_spot_id, container_ref, po_reference, currency,
    fx_pair, fx_rate, fx_method, fx_week_start,
    subtotal, tax_total, total, status, created_by_uid
  ) VALUES (
    v_number,
    p_header->>'leg', p_header->>'seller_entity_code', p_header->>'buyer_entity_code',
    p_header->>'shipment_spot_id', p_header->>'container_ref', p_header->>'po_reference', p_header->>'currency',
    p_header->>'fx_pair', (p_header->>'fx_rate')::numeric, p_header->>'fx_method', (p_header->>'fx_week_start')::date,
    (p_header->>'subtotal')::numeric, (p_header->>'tax_total')::numeric, (p_header->>'total')::numeric,
    COALESCE(p_header->>'status', 'draft'), (p_header->>'created_by_uid')::uuid
  )
  RETURNING id INTO v_id;

  INSERT INTO public.commercial_invoice_lines
    (invoice_id, sku, product_name, qty, unit_value, line_total, hs_code, container_ref, sort_order)
  SELECT
    v_id, l->>'sku', l->>'product_name', (l->>'qty')::numeric, (l->>'unit_value')::numeric,
    (l->>'line_total')::numeric, l->>'hs_code', l->>'container_ref', COALESCE((l->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_lines) AS l;

  RETURN jsonb_build_object('id', v_id, 'invoice_number', v_number);
END;
$$;

REVOKE ALL ON FUNCTION public.create_commercial_invoice(jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_commercial_invoice(jsonb, jsonb) TO service_role;
