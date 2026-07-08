-- ============================================================================
-- MFG PROJECT (cdkpczinzhykcdbfoobn) — applied via MCP, tracked here for the record.
-- (The repo's supabase/migrations/ target the OPS project; mfg has its own schema.)
--
-- Hub-owned MATERIAL PRICE MASTER — the source of truth for material prices,
-- replacing the Google-Sheet price column. The Sheets→n8n sync still provides the
-- recipe (qty/dutiable/structure) in bom_weekly_snapshot.component_detail, but the
-- Hub prices from here and recomputes the BOM totals live (see src/lib/bom-calc.ts).
-- service-role-only (mfg has no auth users — RLS on, zero policies, per convention).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.material_prices (
  material_code    text PRIMARY KEY,
  description      text,
  unit_price_eur   numeric NOT NULL,
  currency         text NOT NULL DEFAULT 'EUR',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_uid   uuid,
  updated_by_label text
);
ALTER TABLE public.material_prices ENABLE ROW LEVEL SECURITY;

-- Seed from the latest snapshot's components (prices already consistent per material).
INSERT INTO public.material_prices (material_code, description, unit_price_eur, currency)
SELECT
  (c->>'code')                                    AS material_code,
  max(c->>'desc')                                 AS description,
  max((c->>'unit_cost_eur')::numeric)             AS unit_price_eur,
  coalesce(max(NULLIF(c->>'currency','')), 'EUR') AS currency
FROM public.bom_weekly_snapshot s
CROSS JOIN LATERAL jsonb_array_elements(s.component_detail) c
WHERE s.week_start_date = (SELECT max(week_start_date) FROM public.bom_weekly_snapshot)
  AND (c->>'code') IS NOT NULL AND (c->>'code') <> ''
GROUP BY (c->>'code')
ON CONFLICT (material_code) DO NOTHING;
