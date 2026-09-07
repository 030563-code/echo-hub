-- Record WHICH component caps a SKU's buildability, not just the number.
--
-- The ceiling on its own is not actionable: "H9 can build 280" does not tell
-- anyone what to go and buy. The binding component does, and it is frequently
-- the surprise — H9 is capped at 280 by four pieces of a metal securing clip
-- while everyone assumes the constraint is fabric.
--
-- Carried as columns rather than encoded into the flags array (the engine's
-- first cut emitted 'materials_bound_by:1781') because a parameterised flag is
-- unqueryable: "which SKUs were fabric-bound this month" is a trivial group-by
-- on a column and a string-prefix scan on a jsonb array. The flags array stays
-- a set of plain enum-ish states.
--
-- desc is denormalised on purpose. This table is a daily snapshot, so it should
-- record the component name AS IT WAS on the run date; joining mrp_bom_component
-- later would re-describe history if a BOM line is ever corrected.

alter table public.mrp_buffer_status_daily
  add column if not exists materials_binding_code text,
  add column if not exists materials_binding_desc text;

comment on column public.mrp_buffer_status_daily.materials_binding_code is
  'Bamida ns_number of the component that caps max_buildable — the thing to reorder. Null when max_buildable is null (no BOM, or no gating component resolvable to a stock card).';

comment on column public.mrp_buffer_status_daily.materials_binding_desc is
  'Human-readable name of materials_binding_code, snapshotted at run time so a later BOM correction cannot re-describe history.';
