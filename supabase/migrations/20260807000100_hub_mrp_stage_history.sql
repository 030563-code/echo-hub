-- MRP hybrid trigger, part 2: stage-transition history + live closed-won capture
-- + stage-weight seed table.
--
-- deal_stage_history makes stage-entry win rates EMPIRICAL over time (today the
-- registry only holds the current status — transitions are invisible).
-- capture_deal_stage_change() also inserts mrp_demand_events rows at the true
-- close moment (status transitions INTO 'closedwon'), replacing the backfill's
-- created_at proxy date with current_date — the trigger fires when the close
-- actually happens, so this IS the commercial date.
--
-- SCHEMA REALITY (verified 2026-08-07 against live korylyniwsqtsvzuzydg):
--   * deals_registry already carries three triggers:
--       - trg_enrich_deal_items         BEFORE INSERT/UPDATE (mutates
--         line_items_raw, merging xero_* keys; preserves "sku"/"quantity")
--       - deals_registry_update         AFTER  INSERT/UPDATE (n8n webhook)
--       - trigger_on_quote_accepted     AFTER  INSERT/UPDATE (webhooks only on
--         deal_status '1170409275')
--     BEFORE triggers fire in name order, so trg_enrich_deal_items runs before
--     trigger_capture_deal_stage_change — the closed-won capture sees the
--     ENRICHED line items (sku/quantity untouched by enrichment). Correct.
--   * 26 distinct deal_status values live: 'closedwon' (488), 'closedlost'
--     (16), 'Quote Created' (4), 11 pipeline-stage UUIDs and 12 numeric stage
--     ids — all seeded below with placeholder weights until the DDS&OP
--     planning session sets real ones.
--   * All 136 existing mrp_demand_events rows already satisfy
--     sku = btrim(sku) and sku <> '' (verified before adding the constraint).

-- ============================================================================
-- 0. Harden mrp_demand_events (carried from Task 1 quality review): the ledger
--    must never accept padded or empty SKUs, from any future writer.
-- ============================================================================
alter table public.mrp_demand_events
  add constraint mrp_demand_events_sku_trimmed_check
  check (sku = btrim(sku) and sku <> '');

-- ============================================================================
-- 1. deal_stage_history — append-only stage-transition log.
-- ============================================================================
create table public.deal_stage_history (
  id bigint generated always as identity primary key,
  deal_id text not null,
  old_status text,
  new_status text,
  changed_at timestamptz not null default now()
);
create index deal_stage_history_deal_changed
  on public.deal_stage_history (deal_id, changed_at);
alter table public.deal_stage_history enable row level security;
create policy "hub: read deal_stage_history"
  on public.deal_stage_history for select to authenticated
  using (true);

-- ============================================================================
-- 2. capture_deal_stage_change() — BEFORE UPDATE on deals_registry.
--    * Any status transition -> one history row.
--    * Transition INTO 'closedwon' with an array line_items_raw -> demand
--      events, event_date = current_date. Region derivation is copied VERBATIM
--      from the Task 1 backfill (depot prefix, then currency, else US) for
--      consistency. Quantity text is btrim'd BEFORE the numeric-regex guard so
--      padded string quantities are handled; non-numeric values are skipped,
--      never crash the deal update. Qty is summed per SKU (same as the
--      backfills) so repeated SKUs are not silently dropped by the unique
--      constraint. on conflict do nothing: a deal already backfilled, or
--      re-closed after a reopen, inserts nothing.
--    RLS note: security definer (owner) bypasses the read-only RLS on both
--    target tables; a trigger-returning function cannot be called via RPC.
-- ============================================================================
create or replace function public.capture_deal_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deal_status is distinct from old.deal_status then
    insert into public.deal_stage_history (deal_id, old_status, new_status)
    values (new.hubspot_deal_id, old.deal_status, new.deal_status);

    if new.deal_status = 'closedwon'
       and jsonb_typeof(new.line_items_raw) = 'array' then
      insert into public.mrp_demand_events
        (event_date, sku, qty, region, source, source_ref)
      select
        current_date                          as event_date,
        nullif(btrim(e->>'sku'), '')          as sku,
        sum((btrim(e->>'quantity'))::numeric) as qty,
        case
          when new.depot_code like 'US-%'     then 'US'
          when new.depot_code like 'CA-%'     then 'CA'
          when new.depot_code = 'EU-France'   then 'FR'
          when new.depot_code like 'EU-%'     then 'OTHER'
          when new.currency = 'CAD'           then 'CA'
          when new.currency = 'GBP'           then 'UK'
          else 'US'
        end                                   as region,
        'hubspot_deal'                        as source,
        new.hubspot_deal_id                   as source_ref
      from jsonb_array_elements(new.line_items_raw) e
      where nullif(btrim(e->>'sku'), '') is not null
        and btrim(e->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
        and (btrim(e->>'quantity'))::numeric > 0
      group by nullif(btrim(e->>'sku'), '')
      on conflict (source, source_ref, sku) do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trigger_capture_deal_stage_change on public.deals_registry;
create trigger trigger_capture_deal_stage_change
  before update on public.deals_registry
  for each row
  execute function public.capture_deal_stage_change();

-- ============================================================================
-- 3. mrp_stage_weights — per-stage win weights for probability-weighted
--    demand. seeded_manually stays true until stage-entry win rates computed
--    from deal_stage_history replace the placeholders.
-- ============================================================================
create table public.mrp_stage_weights (
  stage_id text primary key,
  stage_label text,
  win_weight numeric not null check (win_weight between 0 and 1),
  is_late_stage boolean not null default false,
  seeded_manually boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.mrp_stage_weights enable row level security;
create policy "hub: read mrp_stage_weights"
  on public.mrp_stage_weights for select to authenticated
  using (true);

-- ============================================================================
-- 4. Seed from live statuses. Placeholder weight 0.2 for every open stage
--    (real weights set at the DDS&OP planning session); terminal stages get
--    their true weights (won=1 late-stage, lost=0) — harmless as rows, and
--    they document the boundary conditions.
-- ============================================================================
insert into public.mrp_stage_weights
  (stage_id, stage_label, win_weight, is_late_stage, seeded_manually)
select distinct
  deal_status,
  null,
  case deal_status when 'closedwon' then 1 when 'closedlost' then 0 else 0.2 end,
  deal_status = 'closedwon',
  true
from public.deals_registry
where deal_status is not null
on conflict (stage_id) do nothing;
