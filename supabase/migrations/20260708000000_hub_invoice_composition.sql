-- ============================================================================
-- Echo Barrier Hub — Commercial-invoice COMPOSITION layer + editable-draft audit.
-- Target: ops korylyniwsqtsvzuzydg (SHARED). PURELY ADDITIVE.
--
-- Delivers the two customs cases Juraj raised, driven by config (not code):
--   • CONSOLIDATE — fold ancillary lines (packing, shipping) INTO a product line
--     for a given destination country (e.g. Brazil: H9 + packing + shipping → 1×H9).
--   • SPLIT — expand ONE sale SKU into N invoice lines with per-leg HS codes
--     (e.g. CS Enclosure → Frame + Body, HS codes differing SRO→Group vs the
--     onward leg).
--   • Per-leg HS codes (product_hs_codes) surfaced on the invoice.
--   • destination_country on the invoice header (drives country rules).
--   • Editable-draft audit log (a human override before issue is recorded).
--
-- Behaviour is a NO-OP when no rule/HS-map row matches → existing invoices are
-- byte-identical to before. Seeded rules are SCOPED (specific SKUs / country) so
-- they only fire for the demo cases. HS codes + split ratios are left for Juraj to
-- confirm (config values, not code) — see the `note` columns.
-- ============================================================================

-- 1. Composition rules --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_composition_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  active      boolean NOT NULL DEFAULT true,
  country     text,                              -- NULL = any destination
  leg         text,                              -- NULL = any leg
  rule_type   text NOT NULL CHECK (rule_type IN ('consolidate','split')),
  source_sku  text NOT NULL,                     -- consolidate: TARGET that absorbs; split: SKU to split
  config      jsonb NOT NULL DEFAULT '{}',       -- consolidate: {absorb_skus:[]}; split: {children:[{label,hs_code,share}]}
  note        text,
  priority    integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_composition_rules_match_idx
  ON public.invoice_composition_rules (active, source_sku);

-- 2. Per-leg HS code map (non-split lines) ------------------------------------
CREATE TABLE IF NOT EXISTS public.product_hs_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku         text NOT NULL,
  leg         text NOT NULL DEFAULT '*',         -- '*' = all legs
  hs_code     text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku, leg)
);

-- 3. Editable-draft audit -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.commercial_invoice_edit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  edited_by      uuid REFERENCES auth.users(id),
  edited_by_label text,
  before         jsonb,
  after          jsonb,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_invoice_edit_log_invoice_idx
  ON public.commercial_invoice_edit_log (invoice_id);

-- 4. destination_country on the header (drives country rules) -----------------
ALTER TABLE public.commercial_invoices ADD COLUMN IF NOT EXISTS destination_country text;

-- 5. Update the atomic create RPC to persist destination_country --------------
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
    shipment_spot_id, container_ref, po_reference, currency, destination_country,
    fx_pair, fx_rate, fx_method, fx_week_start,
    subtotal, tax_total, total, status, created_by_uid
  ) VALUES (
    v_number,
    p_header->>'leg', p_header->>'seller_entity_code', p_header->>'buyer_entity_code',
    p_header->>'shipment_spot_id', p_header->>'container_ref', p_header->>'po_reference', p_header->>'currency',
    p_header->>'destination_country',
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

-- 6. RLS ----------------------------------------------------------------------
-- Rules + HS map: read requires invoice.view (config, not price-sensitive); writes service_role.
ALTER TABLE public.invoice_composition_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_composition_rules FROM anon, authenticated;
GRANT SELECT ON public.invoice_composition_rules TO authenticated;
DROP POLICY IF EXISTS "hub: read composition rules" ON public.invoice_composition_rules;
CREATE POLICY "hub: read composition rules" ON public.invoice_composition_rules
  FOR SELECT TO authenticated USING ((SELECT public.has_capability('invoice.view')));

ALTER TABLE public.product_hs_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_hs_codes FROM anon, authenticated;
GRANT SELECT ON public.product_hs_codes TO authenticated;
DROP POLICY IF EXISTS "hub: read hs codes" ON public.product_hs_codes;
CREATE POLICY "hub: read hs codes" ON public.product_hs_codes
  FOR SELECT TO authenticated USING ((SELECT public.has_capability('invoice.view')));

ALTER TABLE public.commercial_invoice_edit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_invoice_edit_log FROM anon, authenticated;
GRANT SELECT ON public.commercial_invoice_edit_log TO authenticated;
DROP POLICY IF EXISTS "hub: read invoice edit log" ON public.commercial_invoice_edit_log;
CREATE POLICY "hub: read invoice edit log" ON public.commercial_invoice_edit_log
  FOR SELECT TO authenticated USING ((SELECT public.has_capability('invoice.view')));

-- 7. Seed the two demo cases (SCOPED; values to confirm with Juraj) -----------
-- Brazil: fold packing + shipping into the H9 product line (one customs line).
-- absorb_skus are PLACEHOLDERS — set to Juraj's real packing/shipping SKUs.
INSERT INTO public.invoice_composition_rules (country, leg, rule_type, source_sku, config, note)
SELECT 'BR', NULL, 'consolidate', 'EBH9NA',
       '{"absorb_skus":["PACKING","SHIPPING","FREIGHT"]}'::jsonb,
       'Brazil: bundle packing+shipping into the H9 unit price. CONFIRM the real packing/shipping SKUs.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.invoice_composition_rules WHERE country='BR' AND rule_type='consolidate' AND source_sku='EBH9NA'
);

-- CS Enclosure → Frame + Body, per-leg HS codes. HS codes + split share TBC (Juraj).
INSERT INTO public.invoice_composition_rules (country, leg, rule_type, source_sku, config, note)
SELECT NULL, 'SRO_TO_GROUP', 'split', 'CCSNA',
       '{"children":[{"label":"CS Enclosure — Frame","hs_code":null,"share":0.5},{"label":"CS Enclosure — Body","hs_code":null,"share":0.5}]}'::jsonb,
       'CS Enclosure split on the SRO→Group leg. CONFIRM the two HS codes + the value split (frame vs body).'
WHERE NOT EXISTS (
  SELECT 1 FROM public.invoice_composition_rules WHERE leg='SRO_TO_GROUP' AND rule_type='split' AND source_sku='CCSNA'
);
INSERT INTO public.invoice_composition_rules (country, leg, rule_type, source_sku, config, note)
SELECT NULL, 'GROUP_TO_USA', 'split', 'CCSNA',
       '{"children":[{"label":"CS Enclosure — Frame","hs_code":null,"share":0.5},{"label":"CS Enclosure — Body","hs_code":null,"share":0.5}]}'::jsonb,
       'CS Enclosure split on the onward leg — HS codes can DIFFER from the SRO→Group leg. CONFIRM.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.invoice_composition_rules WHERE leg='GROUP_TO_USA' AND rule_type='split' AND source_sku='CCSNA'
);
