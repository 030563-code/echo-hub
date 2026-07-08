-- ============================================================================
-- Echo Barrier Hub — cost.view capability (SRO slice 3: price visibility)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- PURELY ADDITIVE. Adds one capability + backfill grants. Nothing the live n8n
-- PO flow reads/writes is touched.
--
-- `cost.view` gates ALL price/cost display on POs, the BOM and supplier docs.
-- Without it (warehouse/production "workers"), the Hub strips every EUR figure
-- SERVER-SIDE before it reaches the client — UI and generated PDFs alike — and
-- the Bamida supplier PO renders as a price-less "BOM PO". `admin` /
-- is_super_admin still imply all capabilities (has_capability), so admins keep
-- full cost visibility automatically.
-- ============================================================================

INSERT INTO public.capabilities (key, module, description) VALUES
  ('cost.view', 'costs', 'See prices/costs on POs, BOM and supplier documents (hidden from warehouse/production workers)')
ON CONFLICT (key) DO UPDATE
  SET module = EXCLUDED.module, description = EXCLUDED.description;

-- bom.view no longer implies seeing prices — reflect that in the catalogue.
UPDATE public.capabilities
  SET description = 'View the bill of materials (specs/structure; prices require cost.view)'
  WHERE key = 'bom.view';

-- Backfill: everyone who today holds po.create / po.approve / bom.edit is a
-- buyer/finance role and keeps cost visibility. (Admins pass via has_capability's
-- 'admin' implication, so they need no explicit grant.)
INSERT INTO public.user_capabilities (user_id, capability)
SELECT DISTINCT uc.user_id, 'cost.view'
FROM public.user_capabilities uc
WHERE uc.capability IN ('po.create', 'po.approve', 'bom.edit')
ON CONFLICT DO NOTHING;
