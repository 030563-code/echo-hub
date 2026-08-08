-- Make the UK/OZ donor-history contract explicit where the next implementer
-- will actually look: on the columns themselves.
--
-- The final branch review flagged that 2,530 of 2,666 mrp_demand_events rows
-- (UK + OZ, back to 2011) are never read by the engine, and that
-- mrp_buffer_profile.family_sku is declared but referenced nowhere in src/.
-- Both observations are correct. Neither is a defect — but the schema implied a
-- capability that does not exist yet, which is worse than saying nothing.
--
-- The contract, stated plainly: UK/OZ demand must NEVER enter a North American
-- ADU. Demand LEVELS are not transferable between regions (UK is hire-led and
-- an order of magnitude larger); averaging them into a NA reorder point would
-- produce buffers unrelated to NA consumption. What IS transferable is the
-- SHAPE of the demand distribution — order-arrival cadence and relative
-- order-size spread — which is a Monte Carlo input (Phase 3), not a DDMRP zone
-- input (Phase 1). The Phase-3 bootstrap resamples jittered UK order sizes for
-- NA SKUs with too few local events to fit their own distribution, scaled to
-- the NA arrival rate. That is the only sanctioned use of family_sku.

comment on column public.mrp_buffer_profile.family_sku is
  'Canonical internal SKU (UK/OZ vocabulary) used ONLY as the donor key for Phase-3 Monte Carlo size-distribution borrowing on SKUs with thin local history. NOT read by the Phase-1 DDMRP engine and deliberately so: UK/OZ demand LEVELS must never enter a North American ADU (different market, hire-led, ~10x volume) — only distribution SHAPE is transferable. Also never aggregate ADU by this column: EBH9NA and EBH9ERNA share family EBH9 and would double-count. Demand routing between spellings of the SAME product is alias_of, not family_sku.';

comment on column public.mrp_demand_events.region is
  'US/CA rows feed the Phase-1 buffer engine ADU/CoV directly. UK/OZ rows (the 15-year MCS backfill) are deliberately NOT read by Phase 1 — they exist as the Phase-3 Monte Carlo donor corpus for distribution shape. See mrp_buffer_profile.family_sku.';
