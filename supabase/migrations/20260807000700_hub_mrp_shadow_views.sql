-- ============================================================================
-- MRP Task 13: shadow-run instrumentation — flap detector + red-action ledger.
--
-- REFRAME vs the plan's original "mrp_shadow_diff (v2 zone vs legacy status)":
-- the legacy MRP path computes its ROP status on page load and PERSISTS
-- NOTHING — there is no legacy status table to diff against, so a literal
-- v2-vs-legacy diff view is impossible. What the shadow exit criteria
-- actually require is:
--   (a) "zero unexplained flapping"        -> a zone-transition (flap) view;
--   (b) "every v2 red actioned/explained"  -> a red-action ledger view.
-- Both derive purely from mrp_buffer_status_daily (the v2 engine's nightly
-- persistence), which the legacy path never writes — so every row here is,
-- by construction, v2 shadow output.
--
-- mrp_shadow_flap: consecutive-run zone transitions per SKU (lag() over
--   run_date). Rows appear ONLY where the zone changed; prev_run_date is
--   included because nightly runs can skip days (cron gaps) — a "day-over-day"
--   flap across a 3-day gap is still a transition, and the reviewer should see
--   the gap. direction: 'worsened' = toward red, 'improved' = toward green.
--
-- mrp_shadow_reds: every (run_date, sku) red row with its action context —
--   the ledger reviewed twice weekly during the shadow run; the DDS&OP rule is
--   "every red actioned or explained" and this view is the checklist source.
--
-- security_invoker = true on both: the views read RLS-protected tables
-- (mrp_buffer_status_daily has authenticated-read policies from Task 8), so
-- authenticated reads flow through the underlying policies instead of the
-- view owner's bypass. Writes: none — views are read-only projections.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Flap detector — consecutive-run zone transitions per SKU
-- ---------------------------------------------------------------------------
create view public.mrp_shadow_flap
with (security_invoker = true) as
with seq as (
  select
    run_date,
    sku,
    zone,
    lag(run_date) over w as prev_run_date,
    lag(zone)     over w as prev_zone
  from public.mrp_buffer_status_daily
  window w as (partition by sku order by run_date)
)
select
  run_date,
  sku,
  prev_run_date,
  prev_zone,
  zone,
  case
    when (case zone      when 'red' then 0 when 'yellow' then 1 else 2 end)
       < (case prev_zone when 'red' then 0 when 'yellow' then 1 else 2 end)
      then 'worsened'
    else 'improved'
  end as direction
from seq
where prev_zone is not null
  and zone <> prev_zone;

comment on view public.mrp_shadow_flap is
  'Shadow-run flap detector: consecutive-run zone transitions per SKU from '
  'mrp_buffer_status_daily (rows only where the zone CHANGED). prev_run_date '
  'exposes cron gaps. Exit criterion: zero UNEXPLAINED flapping over two '
  'consecutive weeks — every row here needs an explanation at DDS&OP. '
  'security_invoker: reads flow through the base table''s RLS.';

-- ---------------------------------------------------------------------------
-- 2. Red-action ledger — every red row with its action context
-- ---------------------------------------------------------------------------
create view public.mrp_shadow_reds
with (security_invoker = true) as
select
  run_date,
  sku,
  action_qty,
  max_buildable,
  blocked_by_materials,
  flags
from public.mrp_buffer_status_daily
where zone = 'red'
order by run_date desc, sku;

comment on view public.mrp_shadow_reds is
  'Shadow-run red-action ledger: every (run_date, sku) red row with '
  'action_qty, materials ceiling and state flags. Reviewed twice weekly '
  'during the shadow run; exit criterion: two consecutive weeks in which '
  'every red was actioned or explained. security_invoker: reads flow through '
  'the base table''s RLS.';
