-- MRP capture trigger v4: guard the stage-history insert like its two siblings.
--
-- PROBLEM with v3's deliberate "must fail loudly" stance: this trigger does not
-- run alone. public.deals_registry carries deals_registry_update (AFTER UPDATE
-- -> supabase_functions.http_request), which QUEUES the outbound n8n webhook in
-- the SAME transaction, and fires alphabetically BEFORE
-- trigger_capture_deal_stage_change. So an unguarded failure here does not just
-- lose one history row — it aborts the production HubSpot deal sync AND rolls
-- back the already-queued outbound notification. That is the wrong trade: the
-- write being protected is deal_stage_history, an analytics table that nothing
-- consumes yet (the stage-weight model is still shadow), and the cost is the
-- live sync spine.
--
-- FIX: wrap the history insert in the identical begin/exception/raise-warning
-- block already used by the demand-capture and hydration-request halves. A
-- failure is now loud in the Postgres log and silent to the transaction. Gap
-- risk is bounded — deal_status transitions are re-derivable from
-- deals_registry, and the win-rate base is not yet in production use.
--
-- Nothing else changes: the body below is the live v3 definition
-- (pg_get_functiondef, 2026-08-08) with only that block modified. The trigger
-- itself is untouched and is deliberately NOT redefined here.

create or replace function public.capture_deal_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status_changed boolean := new.deal_status is distinct from old.deal_status;
  v_items_changed  boolean := old.line_items_raw is distinct from new.line_items_raw;
  v_has_items      boolean := jsonb_typeof(new.line_items_raw) = 'array'
                              and jsonb_array_length(new.line_items_raw) > 0;
begin
  if v_status_changed then
    -- Audit record. GUARDED: this trigger shares deals_registry's AFTER UPDATE
    -- set with deals_registry_update, which queues the n8n webhook in the same
    -- transaction — so raising here would abort the production deal sync and
    -- roll back that notification to protect a not-yet-consumed analytics
    -- table. Loud in the log, silent to the transaction.
    begin
      insert into public.deal_stage_history (deal_id, old_status, new_status)
      values (new.hubspot_deal_id, old.deal_status, new.deal_status);
    exception when others then
      raise warning 'mrp stage-history capture failed for deal %: %',
        new.hubspot_deal_id, sqlerrm;
    end;
  end if;

  -- Demand capture: on transition into closedwon, OR on line-item changes to
  -- an already-closedwon deal (the hydrator's update lands here).
  if new.deal_status = 'closedwon'
     and (v_status_changed or v_items_changed)
     and v_has_items then
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

  -- Hydration request: closed won without usable line items -> ask the n8n
  -- hydrator to fetch them from HubSpot. Fire-and-forget; its deals_registry
  -- update re-enters this trigger via the items-changed path above.
  if v_status_changed and new.deal_status = 'closedwon' and not v_has_items then
    begin
      perform net.http_post(
        url := 'https://medes.app.n8n.cloud/webhook/hydrate-deal-line-items',
        body := jsonb_build_object('deal_id', new.hubspot_deal_id),
        headers := '{"Content-Type": "application/json"}'::jsonb
      );
    exception when others then
      raise warning 'mrp hydration request failed for deal %: %',
        new.hubspot_deal_id, sqlerrm;
    end;
  end if;

  -- AFTER ROW trigger: the return value is ignored.
  return null;
end;
$$;
