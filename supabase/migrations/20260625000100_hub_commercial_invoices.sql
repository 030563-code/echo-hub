-- ============================================================================
-- Echo Barrier Hub — Commercial Invoices (SRO slice: invoicing build, v1)
-- Target: ops korylyniwsqtsvzuzydg (SHARED). PURELY ADDITIVE — 4 new tables, 1
-- sequence, 1 RPC, 2 new capabilities. Touches NOTHING existing (invoices_registry
-- = the sales/Xero side is left alone; n8n PO flows untouched).
--
-- Per-shipment intercompany commercial invoices that "travel with the container":
-- v1 = the EUR SRO→Group leg. Values come from a NEW transfer-price list
-- (`intercompany_prices`) seeded from the BOM SRO cost (Dean/Martin adjust).
-- USD Group→USA + FX (rolling-13-week avg) is slice 2 — the columns are present.
-- Hub-PDF + DB-record only (Xero push is a later n8n phase, per the Xero-via-n8n rule).
-- ============================================================================

-- 1. Legal entities (invoice parties) -----------------------------------------
CREATE TABLE IF NOT EXISTS public.entities (
  code             text PRIMARY KEY,            -- 'EB-SRO' | 'EB-GROUP' | 'EB-USA'
  legal_name       text NOT NULL,
  address_lines    text[] NOT NULL DEFAULT '{}',
  vat_tax_id       text,
  eori             text,
  default_currency text NOT NULL DEFAULT 'EUR',
  xero_contact_id  text,
  xero_tenant_id   text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- SRO block lifted verbatim from src/lib/bamida-po.ts BUYER. Group + USA are
-- placeholders — Dean confirms the registered address + VAT/EORI before issue.
INSERT INTO public.entities (code, legal_name, address_lines, vat_tax_id, default_currency) VALUES
  ('EB-SRO',   'Echo Barrier s.r.o.',         ARRAY['Sturova 3/6','Kosice','04001','Slovakia'], 'SK2023291600', 'EUR'),
  ('EB-GROUP', 'Echo Barrier Group Limited',  ARRAY['— confirm registered address —'],          NULL,           'EUR'),
  ('EB-USA',   'Echo Barrier USA LLC',        ARRAY['— confirm registered address —'],          NULL,           'USD')
ON CONFLICT (code) DO NOTHING;

-- 2. Intercompany transfer-price list (the per-SKU invoice value source) -------
CREATE TABLE IF NOT EXISTS public.intercompany_prices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku        text NOT NULL,
  leg        text NOT NULL,                    -- 'SRO_TO_GROUP' (EUR) | 'GROUP_TO_USA' (USD)
  unit_value numeric NOT NULL,
  currency   text NOT NULL DEFAULT 'EUR',
  active     boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku, leg)
);

-- Seeded from the latest BOM SRO cost (mfg bom_weekly_snapshot, w/c 2026-06-15)
-- as a STARTING POINT — Dean/Martin set the real transfer prices (may add markup).
INSERT INTO public.intercompany_prices (sku, leg, unit_value, currency) VALUES
  ('CCSNA',       'SRO_TO_GROUP', 215.33, 'EUR'),
  ('EBH10HERCNA', 'SRO_TO_GROUP',  22.38, 'EUR'),
  ('EBH10NA',     'SRO_TO_GROUP',  25.68, 'EUR'),
  ('EBH8NA',      'SRO_TO_GROUP',  68.65, 'EUR'),
  ('EBH9ERNA',    'SRO_TO_GROUP',  27.01, 'EUR'),
  ('EBH9NA',      'SRO_TO_GROUP',  27.01, 'EUR'),
  ('EBH9WNA',     'SRO_TO_GROUP',  27.01, 'EUR'),
  ('EBH9XNA',     'SRO_TO_GROUP',  43.72, 'EUR'),
  ('FSCNA',       'SRO_TO_GROUP', 293.67, 'EUR'),
  ('M1NA',        'SRO_TO_GROUP', 100.89, 'EUR'),
  ('V2NA',        'SRO_TO_GROUP',  62.56, 'EUR')
ON CONFLICT (sku, leg) DO NOTHING;

-- 3. Commercial invoice header + lines ----------------------------------------
CREATE TABLE IF NOT EXISTS public.commercial_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number     text UNIQUE NOT NULL,     -- EBGS2026-00001
  leg                text NOT NULL,            -- 'SRO_TO_GROUP' | 'GROUP_TO_USA'
  seller_entity_code text NOT NULL,
  buyer_entity_code  text NOT NULL,
  shipment_spot_id   text,
  container_ref      text,
  po_reference       text,
  currency           text NOT NULL,
  fx_pair            text,                      -- null for the EUR leg
  fx_rate            numeric,                   -- snapshotted at issue (audit)
  fx_method          text,                      -- 'rolling_13w' | 'spot' | null
  fx_week_start      date,
  subtotal           numeric NOT NULL DEFAULT 0,
  tax_total          numeric NOT NULL DEFAULT 0,
  total              numeric NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','sent','superseded')),
  notes              text,
  issued_at          timestamptz,
  created_by_uid     uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_invoices_container_idx ON public.commercial_invoices (container_ref);

CREATE TABLE IF NOT EXISTS public.commercial_invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  sku           text NOT NULL,
  product_name  text NOT NULL,
  qty           numeric NOT NULL,
  unit_value    numeric NOT NULL,              -- snapshotted (audit immutability)
  line_total    numeric NOT NULL,
  hs_code       text,
  container_ref text,
  sort_order    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS commercial_invoice_lines_invoice_idx ON public.commercial_invoice_lines (invoice_id);

-- 4. Numbering RPC (atomic sequence — mirrors get_next_quote_id) ---------------
CREATE SEQUENCE IF NOT EXISTS public.commercial_invoice_seq;
CREATE OR REPLACE FUNCTION public.get_next_commercial_invoice_id()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'EBGS' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.commercial_invoice_seq')::text, 5, '0');
$$;
REVOKE ALL ON FUNCTION public.get_next_commercial_invoice_id() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_commercial_invoice_id() TO service_role;

-- 5. Capabilities (catalogue rows; granted to users separately) ----------------
INSERT INTO public.capabilities (key, module, description) VALUES
  ('invoice.view',   'invoices', 'View commercial invoices'),
  ('invoice.create', 'invoices', 'Generate / issue commercial invoices (requires cost.view — values exposed)')
ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- 6. RLS + grants -------------------------------------------------------------
-- entities: read-all for authenticated (invoice header data, not price-sensitive).
ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.entities FROM anon, authenticated;
GRANT SELECT ON public.entities TO authenticated;
DROP POLICY IF EXISTS "hub: read entities" ON public.entities;
CREATE POLICY "hub: read entities" ON public.entities FOR SELECT TO authenticated USING (true);

-- intercompany_prices: read requires cost.view (sensitive pricing); writes service_role.
ALTER TABLE public.intercompany_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intercompany_prices FROM anon, authenticated;
GRANT SELECT ON public.intercompany_prices TO authenticated;
DROP POLICY IF EXISTS "hub: read intercompany prices" ON public.intercompany_prices;
CREATE POLICY "hub: read intercompany prices" ON public.intercompany_prices
  FOR SELECT TO authenticated USING ((SELECT public.has_capability('cost.view')));

-- commercial_invoices + lines: read requires invoice.view; writes service_role.
ALTER TABLE public.commercial_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_invoices FROM anon, authenticated;
GRANT SELECT ON public.commercial_invoices TO authenticated;
DROP POLICY IF EXISTS "hub: read commercial invoices" ON public.commercial_invoices;
CREATE POLICY "hub: read commercial invoices" ON public.commercial_invoices
  FOR SELECT TO authenticated USING ((SELECT public.has_capability('invoice.view')));

ALTER TABLE public.commercial_invoice_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_invoice_lines FROM anon, authenticated;
GRANT SELECT ON public.commercial_invoice_lines TO authenticated;
DROP POLICY IF EXISTS "hub: read commercial invoice lines" ON public.commercial_invoice_lines;
CREATE POLICY "hub: read commercial invoice lines" ON public.commercial_invoice_lines
  FOR SELECT TO authenticated USING ((SELECT public.has_capability('invoice.view')));
