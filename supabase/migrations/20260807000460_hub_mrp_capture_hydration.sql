-- MRP capture trigger v3: hydration-aware + ordering-immune demand capture.
--
-- PROBLEM: the HubSpot->Supabase sync's stage-change path updates deal_status
-- WITHOUT line items (only the quote-accepted path hydrates line_items_raw —
-- ~7.5% of deals carry items). A deal closing won straight from an unhydrated
-- stage fired capture v2 with an empty/absent array -> the demand event was
-- silently missed, and line items arriving later never re-fired capture
-- (status unchanged -> WHEN clause false).
--
-- FIX, two halves:
--  1. n8n workflow "Deal Line-Item Hydrator (closed-won)" (Lq0OeCqFgzCPT6Xu,
--     webhook /hydrate-deal-line-items) fetches the deal's line items +
--     product SKUs from HubSpot and updates deals_registry. This trigger
--     requests it via pg_net when a deal transitions INTO closedwon with no
--     usable line items (same fire-and-forget pattern as
--     notify_quote_accepted).
--  2. The trigger now ALSO fires demand capture when line_items_raw changes
--     on an already-closedwon deal, so capture is immune to hydration
--     ordering. Inserts stay idempotent via
--     on conflict (source, source_ref, sku) do nothing. Documented stance: a
--     qty EDIT on an already-captured sku does NOT update the ledger; the
--     Task-10 reconciliation net surfaces material gaps.
--
-- Spurious-fire note: trg_enrich_deal_items (BEFORE) rewrites line_items_raw
-- deterministically on every update — unchanged input produces unchanged
-- output, so the IS DISTINCT FROM gate does not fire on no-op updates.

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
    -- Core audit record: deliberately NOT wrapped. If this insert fails the
    -- deal update must fail loudly — losing stage history silently would
    -- corrupt the empirical win-rate base.
    insert into public.deal_stage_history (deal_id, old_status, new_status)
    values (new.hubspot_deal_id, old.deal_status, new.deal_status);
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

drop trigger if exists trigger_capture_deal_stage_change on public.deals_registry;
create trigger trigger_capture_deal_stage_change
  after update on public.deals_registry
  for each row
  when (old.deal_status is distinct from new.deal_status
        or (new.deal_status = 'closedwon'
            and old.line_items_raw is distinct from new.line_items_raw))
  execute function public.capture_deal_stage_change();
