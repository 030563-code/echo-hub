-- MRP hybrid trigger, part 2b: stage-capture hardening (code-quality review
-- corrective for 20260807000100).
--
-- Three changes, NO other behavior change:
--   1. mrp_region_for_deal(depot, currency) — the region CASE that was
--      duplicated verbatim in capture_deal_stage_change() and the Task-1
--      backfill, extracted into one immutable SQL function.
--   2. capture_deal_stage_change(): the mrp_demand_events insert is wrapped in
--      an exception handler — a demand-capture failure must never block the
--      deal update or the stage-history insert. The history insert stays
--      UNwrapped: it is the core audit record and provably safe (three text
--      columns into an identity-PK table with a defaulted timestamp).
--   3. trigger_capture_deal_stage_change recreated as AFTER UPDATE (this is a
--      side-effect-only trigger; BEFORE was a latent hazard — any future edit
--      that returned null would silently suppress deal updates) with
--      WHEN (old.deal_status IS DISTINCT FROM new.deal_status) so the function
--      is not even invoked on no-change updates.
--
-- Ordering note (verified against live korylyniwsqtsvzuzydg):
-- trg_enrich_deal_items is BEFORE UPDATE and mutates NEW.line_items_raw; the
-- stored row therefore contains the ENRICHED value, and AFTER ROW triggers see
-- the stored row — so moving this trigger from BEFORE to AFTER keeps the
-- closed-won capture reading enriched line items. (Under BEFORE it worked only
-- by name-order luck; AFTER makes it structural.)
--
-- Explicitly declined in this pass (deferred — see the plan's DDS&OP notes):
--   * deal_stage_history.changed_by (who moved the stage)
--   * mrp_stage_weights.updated_at auto-touch trigger

-- ============================================================================
-- 1. mrp_region_for_deal — single source of truth for deal -> demand region.
--    Depot prefix wins over currency; falls back to 'US'. Returns ONLY values
--    accepted by mrp_demand_events_region_check
--    ('US','CA','UK','OZ','FR','OTHER'); 'OZ' is never derived from deals.
-- ============================================================================
create or replace function public.mrp_region_for_deal(p_depot_code text, p_currency text)
returns text
language sql
immutable
as $$
  select case
    when p_depot_code like 'US-%'   then 'US'
    when p_depot_code like 'CA-%'   then 'CA'
    when p_depot_code = 'EU-France' then 'FR'
    when p_depot_code like 'EU-%'   then 'OTHER'
    when p_currency = 'CAD'         then 'CA'
    when p_currency = 'GBP'         then 'UK'
    else 'US'
  end
$$;

-- ============================================================================
-- 2. capture_deal_stage_change() — now AFTER UPDATE on deals_registry.
--    Behavior identical to 20260807000100 except: region via
--    mrp_region_for_deal(), demand insert exception-wrapped, AFTER-trigger
--    return semantics (return value ignored; return null by convention).
-- ============================================================================
create or replace function public.capture_deal_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The trigger's WHEN clause (old.deal_status IS DISTINCT FROM
  -- new.deal_status) is the PRIMARY gate — this guard is belt-and-braces in
  -- case the trigger is ever recreated without the WHEN clause.
  if new.deal_status is distinct from old.deal_status then
    -- Core audit record: deliberately NOT wrapped. If this insert fails the
    -- deal update must fail loudly — losing stage history silently would
    -- corrupt the empirical win-rate base.
    insert into public.deal_stage_history (deal_id, old_status, new_status)
    values (new.hubspot_deal_id, old.deal_status, new.deal_status);

    if new.deal_status = 'closedwon'
       and jsonb_typeof(new.line_items_raw) = 'array' then
      -- Demand capture is best-effort: a failure here (bad data, constraint
      -- drift) must never block the deal update or the history insert.
      begin
        insert into public.mrp_demand_events
          (event_date, sku, qty, region, source, source_ref)
        select
          current_date                          as event_date,
          nullif(btrim(e->>'sku'), '')          as sku,
          sum((btrim(e->>'quantity'))::numeric) as qty,
          public.mrp_region_for_deal(new.depot_code, new.currency)
                                                as region,
          'hubspot_deal'                        as source,
          new.hubspot_deal_id                   as source_ref
        from jsonb_array_elements(new.line_items_raw) e
        where nullif(btrim(e->>'sku'), '') is not null
          and btrim(e->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
          and (btrim(e->>'quantity'))::numeric > 0
        group by nullif(btrim(e->>'sku'), '')
        on conflict (source, source_ref, sku) do nothing;
      exception when others then
        raise warning 'mrp demand capture failed for deal %: %',
          new.hubspot_deal_id, sqlerrm;
      end;
    end if;
  end if;

  -- AFTER ROW trigger: the return value is ignored.
  return null;
end;
$$;

-- ============================================================================
-- 3. Recreate the trigger: AFTER UPDATE + WHEN gate. Same name.
-- ============================================================================
drop trigger if exists trigger_capture_deal_stage_change on public.deals_registry;
create trigger trigger_capture_deal_stage_change
  after update on public.deals_registry
  for each row
  when (old.deal_status is distinct from new.deal_status)
  execute function public.capture_deal_stage_change();
