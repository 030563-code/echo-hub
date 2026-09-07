-- ============================================================================
-- Echo Barrier Hub — three-tier PO flow (Depot → Group → SRO, gated at each tier)
-- Target project: korylyniwsqtsvzuzydg.  ADDITIVE.
--
-- New flow (Dean, 2026-06-17, approved diagram docs/po-flow.pdf):
--   • Branch raises a DEPOT_TO_EB_GROUP PO.
--   • APPROVAL 1 (Depot)  → n8n creates the AUTHORISED PO in the DEPOT Xero
--     account; the depot Xero PO# becomes the MASTER number (n8n writes it back,
--     replacing the Hub placeholder). Then the EB_GROUP_TO_SRO leg is raised.
--   • APPROVAL 2 (Group)  → n8n creates the AUTHORISED PO in GROUP Xero (EBG#,
--     reference = master). Then the SRO_TO_SUPPLIER leg is raised.
--   • APPROVAL 3 (SRO)    → n8n creates the AUTHORISED PO in SRO Xero (own #,
--     reference = EBG#, + line items + address).
--
-- Per-tier Xero account, contact, product codes and number write-back all live in
-- n8n (the Xero-via-n8n decision). This migration only widens the Hub data model.
-- ============================================================================

-- 1. Allow the third leg.
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_leg_check;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_leg_check
  CHECK (leg = ANY (ARRAY['DEPOT_TO_EB_GROUP','EB_GROUP_TO_SRO','SRO_TO_SUPPLIER']));

-- 2. Cross-reference shown on each leg (group → master depot#, sro → EBG#).
--    Written by n8n once it knows the parent leg's real Xero PO#.
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS reference_po_number text;

-- 3. Link the Hub catalogue SKU to product_code_master.internal_sku so the raise
--    form can show the selected depot's Xero product code, and n8n can resolve the
--    per-entity code at each tier.
ALTER TABLE public.po_product_catalog
  ADD COLUMN IF NOT EXISTS internal_sku text;

UPDATE public.po_product_catalog AS c SET internal_sku = v.isku
FROM (VALUES
  ('EBH9NA','EBH9'), ('EBH9WNA','EBH9W'), ('EBH9XNA','EBH9X'), ('EBH9ERNA','EBH9'),
  ('EBH10NA','EBH10'), ('EBH10HERCNA','EBH10HERC'), ('EBH8NA','EBH8'),
  ('V2NA','V2'), ('CCSNA','COMP'), ('FSCNA','FSCS'),
  ('BUNNA','BUN'), ('HKNA','HK'), ('EBVFKNA','VFK'), ('M1NA','M1')
) AS v(sku, isku)
WHERE c.sku = v.sku;

-- 4. Widen the approve policy so a po.approve holder can approve a Hub-raised,
--    still-`requested` leg at ANY of the three tiers (requested → approved/rejected).
DROP POLICY IF EXISTS "hub: approve PO" ON public.purchase_orders;
CREATE POLICY "hub: approve PO"
  ON public.purchase_orders FOR UPDATE TO authenticated
  USING (
    (SELECT public.has_capability('po.approve'))
    AND source = 'hub'
    AND status = 'requested'
    AND leg IN ('DEPOT_TO_EB_GROUP', 'EB_GROUP_TO_SRO', 'SRO_TO_SUPPLIER')
  )
  WITH CHECK (
    (SELECT public.has_capability('po.approve'))
    AND source = 'hub'
    AND status IN ('approved', 'rejected')
    AND leg IN ('DEPOT_TO_EB_GROUP', 'EB_GROUP_TO_SRO', 'SRO_TO_SUPPLIER')
  );
