-- ============================================================================
-- Echo Barrier Hub — deals_registry: capability + region (pipeline) scoping
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
--
-- ⚠️ STAGED — DO NOT MERGE TO PROD UNTIL PHASE 5 / QUOTES SIGN-OFF.
-- This REPLACES the live depot-scoped deals_registry RLS (from 20260604) with
-- capability + region scoping. Because deals_registry is shared with the live
-- sales-hub app, applying this to PRODUCTION changes that app's access too.
--
-- Preconditions before any prod apply:
--   1. 20260612000000_hub_capability_model.sql applied (provides has_capability).
--   2. Every live user who needs deal access holds quotes.view / quotes.create
--      (the capability-model migration backfills the current users).
--   3. deals_registry.pipeline_id is populated for the rows users must see
--      (NULL-pipeline rows are visible to admins only under this policy — fail
--      closed; verify population before flipping prod).
--
-- Row scope decision (Dean, 2026-06-12): scope by region (pipeline_id), not depot.
-- ============================================================================

DROP POLICY IF EXISTS "Users see deals for their depots"    ON public.deals_registry;
DROP POLICY IF EXISTS "Users insert deals for their depots" ON public.deals_registry;
DROP POLICY IF EXISTS "Users update deals for their depots" ON public.deals_registry;

-- SELECT: hold quotes.view AND (super-admin OR deal is in the caller's region).
CREATE POLICY "hub: read deals in region"
  ON public.deals_registry FOR SELECT TO authenticated
  USING (
    (SELECT public.has_capability('quotes.view'))
    AND (
      (SELECT public.is_super_admin())
      OR (
        pipeline_id IS NOT NULL
        AND pipeline_id = (SELECT pipeline_id FROM public.profiles WHERE id = (SELECT auth.uid()))
      )
    )
  );

-- INSERT: hold quotes.create AND target the caller's region.
CREATE POLICY "hub: insert deals in region"
  ON public.deals_registry FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.has_capability('quotes.create'))
    AND (
      (SELECT public.is_super_admin())
      OR (
        pipeline_id IS NOT NULL
        AND pipeline_id = (SELECT pipeline_id FROM public.profiles WHERE id = (SELECT auth.uid()))
      )
    )
  );

-- UPDATE: hold quotes.create AND row stays in the caller's region (USING + CHECK).
CREATE POLICY "hub: update deals in region"
  ON public.deals_registry FOR UPDATE TO authenticated
  USING (
    (SELECT public.has_capability('quotes.create'))
    AND (
      (SELECT public.is_super_admin())
      OR (
        pipeline_id IS NOT NULL
        AND pipeline_id = (SELECT pipeline_id FROM public.profiles WHERE id = (SELECT auth.uid()))
      )
    )
  )
  WITH CHECK (
    (SELECT public.has_capability('quotes.create'))
    AND (
      (SELECT public.is_super_admin())
      OR (
        pipeline_id IS NOT NULL
        AND pipeline_id = (SELECT pipeline_id FROM public.profiles WHERE id = (SELECT auth.uid()))
      )
    )
  );

-- No DELETE policy: deals are never deleted from the registry via the Hub.
