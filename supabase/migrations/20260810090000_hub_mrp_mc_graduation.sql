-- ============================================================================
-- MRP Task 19: per-SKU Monte Carlo graduation rule.
--
-- Graduated SKUs trigger the nightly engine on simulated stockout risk
-- (p_stockout > mc_threshold) instead of the classic zone crossing
-- (nfp <= yellow_top). The red zone is RETAINED as a hard guardrail
-- regardless of mc_graduated — a red buffer always triggers, whatever the
-- probability says (engine.ts's `triggered` formula, item 11). Flipped per
-- SKU at DDS&OP only after the backtest (Task 18, scripts/backtest-mc-uk.ts)
-- shows the MC beats zones for that SKU on two consecutive monthly reviews.
-- ============================================================================
alter table public.mrp_buffer_profile
  add column mc_graduated boolean not null default false,
  add column mc_threshold numeric not null default 0.12;

comment on column public.mrp_buffer_profile.mc_graduated is
  'When true the nightly trigger for this SKU is p_stockout > mc_threshold instead of nfp <= yellow_top. Zones are RETAINED as guardrails: a red zone still triggers regardless. Flipped per SKU at DDS&OP only after the backtest shows the MC beats zones for that SKU on two consecutive monthly reviews (plan Task 19).';
comment on column public.mrp_buffer_profile.mc_threshold is
  'p_stockout trigger threshold when mc_graduated. Plan defaults: 0.03 core, 0.12 slow.';

-- trigger_reason records WHICH rule fired the container-candidate gate, so
-- the shadow board and drafted-PO rationale can say "red guardrail" vs
-- "MC risk" instead of leaving the operator to infer it from raw numbers.
alter table public.mrp_buffer_status_daily
  add column trigger_reason text;

comment on column public.mrp_buffer_status_daily.trigger_reason is
  '''zone'' | ''mc'' | null. Set whenever the row entered the container-candidate program: ''zone'' for the classic red/yellow crossing (or the red guardrail on a graduated SKU), ''mc'' for a graduated SKU triggered by p_stockout > mc_threshold while sitting in yellow or green. Null = not triggered.';
