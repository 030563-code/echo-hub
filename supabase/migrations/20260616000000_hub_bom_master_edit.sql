-- ============================================================================
-- Echo Barrier Hub — BOM explosion + master price editing (ops side)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks").
--
-- Decisions (Dean 2026-06-16): the PO BOM is a LIVE read of the master
-- mfg.bom_weekly_snapshot (no per-PO snapshot); editing targets the master
-- component_detail; the Bamida side is a draft VIEW (record only); the explosion
-- surfaces automatically once the EB_GROUP_TO_SRO leg is approved.
--
-- This migration is ops-side + ADDITIVE. The actual BOM data + edits live in the
-- separate mfg project (cdkpczinzhykcdbfoobn); the Hub writes those via the mfg
-- service-role client AFTER an ops-side `bom.edit` capability check (mfg has no
-- auth users, so service-role-after-capability is the gate — like the BOM reads).
--
-- What this adds:
--   1. po_product_catalog.bom_model_code — maps a PO SKU to its mfg model_code
--      so an SRO PO line can be exploded into the right BOM.
--   2. the `bom.edit` capability.
--   3. bom_edit_log — an audit trail of every master price edit (the history a
--      spreadsheet doesn't keep). Read for BOM users; written only via service role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SKU → mfg model_code map on the catalogue
-- ----------------------------------------------------------------------------
ALTER TABLE public.po_product_catalog
  ADD COLUMN IF NOT EXISTS bom_model_code text;

UPDATE public.po_product_catalog AS c SET bom_model_code = v.mc
FROM (VALUES
  ('EBH9NA',      'H9'),
  ('EBH9WNA',     'H9W'),
  ('EBH9XNA',     'H9X 2.1W'),   -- generic H9X → 2.1W (H9X 1.5W also exists; confirm)
  ('EBH9ERNA',    'H9'),         -- Ex-Rental shares the H9 BOM
  ('EBH10NA',     'H10'),
  ('EBH10HERCNA', 'H10HercBlack'),
  ('EBH8NA',      'H8'),
  ('V2NA',        'V2'),
  ('CCSNA',       'CSCompact'),
  ('FSCNA',       'CSFullSize'),
  ('M1NA',        'M1')
) AS v(sku, mc)
WHERE c.sku = v.sku;
-- BUNNA / HKNA / EBVFKNA (accessories) intentionally left NULL — no barrier BOM.

-- ----------------------------------------------------------------------------
-- 2. bom.edit capability (catalogue — keep in sync with src/lib/capabilities.ts)
-- ----------------------------------------------------------------------------
INSERT INTO public.capabilities (key, module, description) VALUES
  ('bom.edit', 'bom', 'Edit master BOM component prices/details (saved to the mfg snapshot)')
ON CONFLICT (key) DO UPDATE
  SET module = EXCLUDED.module, description = EXCLUDED.description;

-- ----------------------------------------------------------------------------
-- 3. bom_edit_log — audit trail of master price edits
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bom_edit_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_code      text NOT NULL,
  week_start_date date,
  edited_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  edited_by_label text,
  before          jsonb,
  after           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bom_edit_log_model_created_idx
  ON public.bom_edit_log (model_code, created_at DESC);

ALTER TABLE public.bom_edit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bom_edit_log FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.bom_edit_log FROM authenticated;
GRANT SELECT ON public.bom_edit_log TO authenticated;

-- Readable by anyone who can see the BOM module; writes go via the service-role
-- bom.edit server action only (never directly by authenticated). has_capability is
-- wrapped in (SELECT …) per the RLS-performance guidance.
DROP POLICY IF EXISTS "bom_edit_log readable by bom users" ON public.bom_edit_log;
CREATE POLICY "bom_edit_log readable by bom users"
  ON public.bom_edit_log FOR SELECT TO authenticated
  USING (
    (SELECT public.has_capability('bom.view'))
    OR (SELECT public.has_capability('bom.edit'))
  );
