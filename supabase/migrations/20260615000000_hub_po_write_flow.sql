-- ============================================================================
-- Echo Barrier Hub — PO write flow (raise + approve in the Hub)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- PURELY ADDITIVE. The Hub becomes the writer for the FRONT of the intercompany
-- PO lifecycle (depot raises → EB-Group admin approval), while the live n8n
-- workflows keep writing as service_role (RLS-immune) and are UNAFFECTED by the
-- new `authenticated` write policies below.
--
-- Coexistence with n8n (Decision 1, Dean 2026-06-15): the Hub owns Hub-raised
-- rows only — marked `source = 'hub'`. n8n PO Phase 1 (hourly Xero poll) keeps
-- producing `source = 'n8n'` rows; the Hub never touches those. n8n PO Phase 2
-- is dormant (0 executions ever) so there is no live downstream to disturb.
--
-- What this adds:
--   1. Identity columns on purchase_orders (requested_by_uid / approved_by_uid)
--      mapped to auth.users — WITHOUT overloading the free-text requested_by /
--      approved_by columns n8n writes labels into.
--   2. A `source` marker ('hub' | 'n8n') + `delivery_address` on the header.
--   3. hs_code + unit_price on lines (the picklist + value fields the raise form
--      captures). Pricing detail / BOM explosion stays OUT of scope.
--   4. Capability-gated write RLS for `authenticated` (po.create to raise a
--      DEPOT_TO_EB_GROUP row in your own depot; po.approve to flip requested →
--      approved/rejected). The existing read-all + service_role policies stay.
--   5. Hub-owned picklist tables (product catalogue, HS codes, delivery
--      addresses), read-all for authenticated, service-role-managed.
--
-- The EB_GROUP_TO_SRO child row (created on approval) is written server-side via
-- the service-role client after the po.approve gate — it is an intercompany row,
-- not the approver's own depot, so it intentionally does NOT get an authenticated
-- INSERT policy (mirrors the admin.ts privileged-write pattern).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. purchase_orders — additive columns
-- ----------------------------------------------------------------------------
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS requested_by_uid uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_uid  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'n8n';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_source_check'
  ) THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_source_check CHECK (source IN ('hub', 'n8n'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS purchase_orders_source_status_idx
  ON public.purchase_orders (source, status);
CREATE INDEX IF NOT EXISTS purchase_orders_requested_by_uid_idx
  ON public.purchase_orders (requested_by_uid);

-- ----------------------------------------------------------------------------
-- 2. purchase_order_lines — additive columns
-- ----------------------------------------------------------------------------
ALTER TABLE public.purchase_order_lines
  ADD COLUMN IF NOT EXISTS hs_code    text,
  ADD COLUMN IF NOT EXISTS unit_price numeric;

-- ----------------------------------------------------------------------------
-- 3. Picklist reference tables (Hub-owned). Read-all for authenticated; writes
--    via service-role only (seeded here; Yuri/Juraj edit via a later admin UI).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.po_product_catalog (
  sku            text PRIMARY KEY,
  product_name   text,
  product_family text,
  region         text NOT NULL DEFAULT 'NA',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.po_hs_codes (
  code        text PRIMARY KEY,
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.po_delivery_addresses (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity     text NOT NULL,
  label      text NOT NULL,
  address    text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the NA product catalogue (US + Canada v1 scope). product_family = the
-- "product code" picklist value Dean referenced (H9 / H10 / H8 / V2 / …).
INSERT INTO public.po_product_catalog (sku, product_name, product_family, region) VALUES
  ('EBH9NA',      'Echo Barrier H9',            'H9',  'NA'),
  ('EBH9WNA',     'Echo Barrier H9W',           'H9',  'NA'),
  ('EBH9XNA',     'Echo Barrier H9X',           'H9',  'NA'),
  ('EBH9ERNA',    'Echo Barrier H9 Ex Rental',  'H9',  'NA'),
  ('EBH10NA',     'Echo Barrier H10',           'H10', 'NA'),
  ('EBH10HERCNA', 'Echo Barrier H10 HERC',      'H10', 'NA'),
  ('EBH8NA',      'Echo Barrier H8',            'H8',  'NA'),
  ('V2NA',        'Echo Barrier V2',            'V2',  'NA'),
  ('CCSNA',       'Compact Cutting Station',    'CS',  'NA'),
  ('FSCNA',       'Full Size Cutting Station',  'CS',  'NA'),
  ('BUNNA',       'Bungies',                    'ACC', 'NA'),
  ('HKNA',        'Hooks',                      'ACC', 'NA'),
  ('EBVFKNA',     'Vertical Fitting Kits',      'ACC', 'NA'),
  ('M1NA',        'M1 Mini Gen Set',            'GEN', 'NA')
ON CONFLICT (sku) DO UPDATE
  SET product_name = EXCLUDED.product_name,
      product_family = EXCLUDED.product_family,
      region = EXCLUDED.region;

-- Delivery-address placeholders per entity. ⚠️ Addresses are placeholders —
-- Echo Barrier confirms the real ship-to addresses (edit via service-role / UI).
INSERT INTO public.po_delivery_addresses (entity, label, address) VALUES
  ('US-BAL',   'US — Baltimore depot',     '— confirm ship-to address —'),
  ('US-SBD',   'US — San Bernardino depot','— confirm ship-to address —'),
  ('CA-HAM',   'CA — Hamilton depot',      '— confirm ship-to address —'),
  ('EB-GROUP', 'EB Group',                 '— confirm address —'),
  ('EB-SRO',   'EB SRO (Slovakia)',        '— confirm address —')
ON CONFLICT DO NOTHING;

-- po_hs_codes intentionally left UNSEEDED — Echo Barrier supplies the authoritative
-- customs HS codes; the raise form treats hs_code as optional until populated.

ALTER TABLE public.po_product_catalog    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_hs_codes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_delivery_addresses ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['po_product_catalog','po_hs_codes','po_delivery_addresses']
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS "picklist readable by authenticated" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "picklist readable by authenticated" ON public.%I FOR SELECT TO authenticated USING (true)', t);
  END LOOP;
END$$;

-- ----------------------------------------------------------------------------
-- 4. Write RLS on purchase_orders / purchase_order_lines.
--    The existing policies (SELECT read-all for authenticated; ALL for
--    service_role) are LEFT IN PLACE. We only ADD the two write paths.
-- ----------------------------------------------------------------------------
GRANT INSERT, UPDATE ON public.purchase_orders      TO authenticated;
GRANT INSERT          ON public.purchase_order_lines TO authenticated;

-- INSERT: a po.create holder raises a DEPOT_TO_EB_GROUP root PO for one of THEIR
-- depots. po_number / master_ref are filled by the existing po_before_insert
-- trigger (Decision 5: keep generate_po_number()). source must be 'hub'.
DROP POLICY IF EXISTS "hub: raise PO" ON public.purchase_orders;
CREATE POLICY "hub: raise PO"
  ON public.purchase_orders FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.has_capability('po.create'))
    AND leg = 'DEPOT_TO_EB_GROUP'
    AND to_entity = 'EB-GROUP'
    AND status = 'requested'
    AND parent_po_id IS NULL
    AND source = 'hub'
    AND requested_by_uid = (SELECT auth.uid())
    AND (
      (SELECT public.is_super_admin())
      OR 'ALL' = ANY (COALESCE((SELECT allowed_depots FROM public.profiles WHERE id = (SELECT auth.uid())), ARRAY[]::text[]))
      OR from_entity = ANY (COALESCE((SELECT allowed_depots FROM public.profiles WHERE id = (SELECT auth.uid())), ARRAY[]::text[]))
    )
  );

-- UPDATE: a po.approve holder flips a Hub-raised, still-`requested`
-- DEPOT_TO_EB_GROUP row to approved or rejected. USING pins the pre-image
-- (requested + hub + correct leg); WITH CHECK pins the post-image to the only two
-- legal target states. No other status, leg, or source is reachable this way, so
-- an approver can never touch n8n rows or the SRO leg.
DROP POLICY IF EXISTS "hub: approve PO" ON public.purchase_orders;
CREATE POLICY "hub: approve PO"
  ON public.purchase_orders FOR UPDATE TO authenticated
  USING (
    (SELECT public.has_capability('po.approve'))
    AND leg = 'DEPOT_TO_EB_GROUP'
    AND source = 'hub'
    AND status = 'requested'
  )
  WITH CHECK (
    (SELECT public.has_capability('po.approve'))
    AND leg = 'DEPOT_TO_EB_GROUP'
    AND source = 'hub'
    AND status IN ('approved', 'rejected')
  );

-- Lines: a po.create holder may add lines ONLY to a Hub-raised PO they own and
-- that is still `requested` (so lines can't be appended post-approval).
DROP POLICY IF EXISTS "hub: add PO lines" ON public.purchase_order_lines;
CREATE POLICY "hub: add PO lines"
  ON public.purchase_order_lines FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.has_capability('po.create'))
    AND EXISTS (
      SELECT 1 FROM public.purchase_orders po
      WHERE po.id = po_id
        AND po.source = 'hub'
        AND po.status = 'requested'
        AND po.requested_by_uid = (SELECT auth.uid())
    )
  );
