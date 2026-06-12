-- ============================================================================
-- Echo Barrier Hub — Weeklies tracker (Phase 4)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks").
--
-- NET-NEW, additive. A generic weekly operating-cadence board: items bucketed by
-- day (Mon/Tue/Wed) per week, with owner + status. The exact fields/structure are
-- PROVISIONAL pending the Monday design session (per the vision doc) — this gives
-- the team a working tracker in the meantime.
--
-- Requires 20260612000000_hub_capability_model.sql (has_capability). RLS: read =
-- weeklies.view; write = weeklies.edit. Unlike user_capabilities, this table IS
-- user-writable (editors add items via their own session), so authenticated holds
-- the write grants, gated by the policies.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.weekly_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_date date NOT NULL,
  day             text NOT NULL CHECK (day IN ('mon', 'tue', 'wed')),
  title           text NOT NULL,
  owner           text,
  status          text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS weekly_items_week_day_idx
  ON public.weekly_items (week_start_date, day);

ALTER TABLE public.weekly_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.weekly_items FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_items TO authenticated;

DROP POLICY IF EXISTS "weeklies read"   ON public.weekly_items;
DROP POLICY IF EXISTS "weeklies insert" ON public.weekly_items;
DROP POLICY IF EXISTS "weeklies update" ON public.weekly_items;
DROP POLICY IF EXISTS "weeklies delete" ON public.weekly_items;

CREATE POLICY "weeklies read" ON public.weekly_items FOR SELECT TO authenticated
  USING ((SELECT public.has_capability('weeklies.view')));

CREATE POLICY "weeklies insert" ON public.weekly_items FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.has_capability('weeklies.edit')) AND created_by = (SELECT auth.uid()));

CREATE POLICY "weeklies update" ON public.weekly_items FOR UPDATE TO authenticated
  USING ((SELECT public.has_capability('weeklies.edit')))
  WITH CHECK ((SELECT public.has_capability('weeklies.edit')));

CREATE POLICY "weeklies delete" ON public.weekly_items FOR DELETE TO authenticated
  USING ((SELECT public.has_capability('weeklies.edit')));
