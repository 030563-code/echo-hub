-- The Monte Carlo layer (plan Task 17) models lead time as mfg + ocean +
-- customs, but mrp_lead_time_actuals' leg check predates it and only knew
-- mfg/ocean/door — so the customs leg could never accumulate observations and
-- would fall back to its Triangular(5,9,21) seed forever. Extend the allowed
-- set; 'door' remains the composite port-to-door leg used by DLT calibration
-- (see the column comment) and is unaffected.
alter table public.mrp_lead_time_actuals
  drop constraint mrp_lead_time_actuals_leg_check;

alter table public.mrp_lead_time_actuals
  add constraint mrp_lead_time_actuals_leg_check
  check (leg = any (array['mfg'::text, 'ocean'::text, 'customs'::text, 'door'::text]));
