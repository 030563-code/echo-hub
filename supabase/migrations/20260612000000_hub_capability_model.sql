-- ============================================================================
-- Echo Barrier Hub — per-user capability model (Phase 1)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- PURELY ADDITIVE. Creates the capability catalogue + per-user grants + a
-- SECURITY DEFINER check helper, and backfills capabilities for existing users.
-- Touches NOTHING the live sales-hub depends on (profiles, deals_registry RLS,
-- is_super_admin all unchanged here). Safe to apply ahead of the Quotes module.
--
-- Design:
--   * Capabilities = WHICH ACTIONS/MODULES (this file). Orthogonal to row-scope,
--     which `profiles` already answers (pipeline_id = region, allowed_depots,
--     is_super_admin).
--   * `admin` capability and `profiles.is_super_admin` both imply ALL capabilities.
--   * Escalation defense (mirrors the 20260604 profiles column-grant lockdown):
--     `authenticated` may SELECT its own capability rows but has NO write grant.
--     Grants/revokes run through the service-role client after a server-side
--     admin check.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. capabilities — the catalogue (keep in sync with src/lib/capabilities.ts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capabilities (
  key         text PRIMARY KEY,
  module      text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.capabilities (key, module, description) VALUES
  ('quotes.view',    'quotes',          'View quotes and the deals pipeline'),
  ('quotes.create',  'quotes',          'Create and send quotes (sets probability of close)'),
  ('po.view',        'purchase-orders', 'View purchase orders'),
  ('po.create',      'purchase-orders', 'Raise purchase orders (pre-approval)'),
  ('po.approve',     'purchase-orders', 'Approve / authorise purchase orders'),
  ('bom.view',       'bom',             'View the bill of materials and pricing'),
  ('transport.view', 'transport',       'View shipments and transport tracking'),
  ('weeklies.view',  'weeklies',        'View the Mondays/Tuesdays/Wednesdays tracker'),
  ('admin',          'admin',           'Full administrative access (implies all capabilities)')
ON CONFLICT (key) DO UPDATE
  SET module = EXCLUDED.module, description = EXCLUDED.description;

-- ----------------------------------------------------------------------------
-- 2. user_capabilities — per-user grants
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_capabilities (
  user_id    uuid NOT NULL REFERENCES auth.users(id)        ON DELETE CASCADE,
  capability text NOT NULL REFERENCES public.capabilities(key) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, capability)
);

CREATE INDEX IF NOT EXISTS user_capabilities_user_id_idx
  ON public.user_capabilities (user_id);

-- ----------------------------------------------------------------------------
-- 3. RLS + grants
-- ----------------------------------------------------------------------------
ALTER TABLE public.capabilities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_capabilities ENABLE ROW LEVEL SECURITY;

-- capabilities: catalogue is readable by any authenticated user; never writable
-- by anon/authenticated (seeded by migration / service-role only).
REVOKE ALL ON public.capabilities FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.capabilities FROM authenticated;
GRANT SELECT ON public.capabilities TO authenticated;

DROP POLICY IF EXISTS "Capabilities readable by authenticated" ON public.capabilities;
CREATE POLICY "Capabilities readable by authenticated"
  ON public.capabilities FOR SELECT TO authenticated
  USING (true);

-- user_capabilities: a user reads their OWN rows (super-admins read all). No
-- write grant to authenticated/anon — writes go via the service-role client.
REVOKE ALL ON public.user_capabilities FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_capabilities FROM authenticated;
GRANT SELECT ON public.user_capabilities TO authenticated;

DROP POLICY IF EXISTS "Users read own capabilities" ON public.user_capabilities;
CREATE POLICY "Users read own capabilities"
  ON public.user_capabilities FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.is_super_admin()));

-- ----------------------------------------------------------------------------
-- 4. has_capability(text) — the policy/server check. SECURITY DEFINER so it can
--    read user_capabilities regardless of the caller's RLS; search_path pinned.
--    `admin` capability OR super-admin ⇒ true for any capability.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_capability(cap text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.user_capabilities uc
        WHERE uc.user_id = auth.uid()
          AND uc.capability IN (cap, 'admin')
      );
$$;

-- Not for anon. Executable by authenticated (used in RLS policies + server gates).
REVOKE EXECUTE ON FUNCTION public.has_capability(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_capability(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. Backfill existing users so the (separate) deals_registry tightening can't
--    lock anyone out. Super-admins → 'admin'; existing non-admin profiles were
--    sales agents → baseline quote capabilities. Idempotent.
-- ----------------------------------------------------------------------------
INSERT INTO public.user_capabilities (user_id, capability)
SELECT id, 'admin' FROM public.profiles WHERE is_super_admin = true
ON CONFLICT DO NOTHING;

INSERT INTO public.user_capabilities (user_id, capability)
SELECT p.id, c.key
FROM public.profiles p
CROSS JOIN (VALUES ('quotes.view'), ('quotes.create')) AS c(key)
WHERE p.is_super_admin = false
ON CONFLICT DO NOTHING;
