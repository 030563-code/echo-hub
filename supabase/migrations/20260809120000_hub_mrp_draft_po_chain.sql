-- ============================================================================
-- Echo Barrier Hub — MRP red-zone PO-chain pre-draft (Task 16)
-- Target project: korylyniwsqtsvzuzydg ("Hubspot Shipping and Stocks") — SHARED.
-- PURELY ADDITIVE (new function only).
--
-- Why "quiet" mode exists: the nightly MRP engine drafts the 3-leg intercompany
-- PO chain (Depot → Group → SRO) the moment a SKU goes red and unblocked, ahead
-- of any human review. `purchase_orders` already carries two live side effects
-- on ordinary inserts — a BEFORE-INSERT trigger that mints po_number/master_ref,
-- and AFTER-INSERT webhooks that fire out to live n8n → Slack/Xero. Neither is
-- appropriate for an engine-drafted, still-`requested` chain: minting a real
-- number before the row shape is even final would collide with the p_prefix
-- scheme below, and posting to Slack/Xero for a row nobody has looked at yet
-- would be a false operational signal. `p_quiet` (default true) sets
-- `session_replication_role = replica` for the duration of the call, which
-- suppresses both triggers (verified available to the runtime role) — so this
-- function sets EVERY column the BEFORE-INSERT trigger would otherwise have
-- filled, explicitly, below. The production Slack ping for these drafts is
-- explicitly OUT OF SCOPE here: it lands at the Phase-2 cutover (plan Task 16
-- note; the shadow board still runs read-only until then).
--
-- Idempotency: re-running the same run_date's draft is a no-op — a
-- purchase_orders row already at po_number = p_prefix || '-01' short-circuits
-- the whole call with a `skipped` result rather than raising a duplicate chain.
-- ============================================================================

create or replace function public.mrp_draft_po_chain(p_master jsonb, p_quiet boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix       text := p_master->>'po_prefix';
  v_rationale    text := p_master->>'rationale';
  v_depot        text := p_master->>'depot';
  v_lines        jsonb := coalesce(p_master->'lines', '[]'::jsonb);
  v_po01_number  text := v_prefix || '-01';
  v_po02_number  text := v_prefix || '-02';
  v_po03_number  text := v_prefix || '-03';
  v_master_ref   text := 'MR-' || v_po01_number;
  v_po01_id      uuid;
  v_po02_id      uuid;
  v_po03_id      uuid;
  v_existing_id  uuid;
begin
  -- Suppress the BEFORE-INSERT po_number generator and the AFTER-INSERT
  -- webhook triggers for this call only (SET LOCAL is transaction-scoped and
  -- reverts automatically at commit/rollback).
  if p_quiet then
    set local session_replication_role = replica;
  end if;

  select id into v_existing_id
    from public.purchase_orders
   where po_number = v_po01_number;

  if found then
    return jsonb_build_object('skipped', 'exists', 'master_ref', v_master_ref);
  end if;

  -- Leg 1: Depot -> EB-GROUP (root of the chain).
  insert into public.purchase_orders
    (po_number, master_ref, leg, from_entity, to_entity, parent_po_id,
     status, source, requested_by, notes)
  values
    (v_po01_number, v_master_ref, 'DEPOT_TO_EB_GROUP', v_depot, 'EB-GROUP', null,
     'requested', 'hub', 'mrp-engine', v_rationale)
  returning id into v_po01_id;

  -- Leg 2: EB-GROUP -> EB-SRO.
  insert into public.purchase_orders
    (po_number, master_ref, leg, from_entity, to_entity, parent_po_id,
     status, source, requested_by, notes)
  values
    (v_po02_number, v_master_ref, 'EB_GROUP_TO_SRO', 'EB-GROUP', 'EB-SRO', v_po01_id,
     'requested', 'hub', 'mrp-engine', v_rationale)
  returning id into v_po02_id;

  -- Leg 3: EB-SRO -> SUPPLIER (manufacturing leg — lifecycle_stage 'sro').
  insert into public.purchase_orders
    (po_number, master_ref, leg, from_entity, to_entity, parent_po_id,
     status, source, requested_by, notes, lifecycle_stage)
  values
    (v_po03_number, v_master_ref, 'SRO_TO_SUPPLIER', 'EB-SRO', 'SUPPLIER', v_po02_id,
     'requested', 'hub', 'mrp-engine', v_rationale, 'sro')
  returning id into v_po03_id;

  -- Each leg restates the full program (mirrors the existing chain pattern —
  -- see hub_approve_po_leg, which copies lines forward leg to leg).
  insert into public.purchase_order_lines (po_id, sku, product_name, quantity)
  select p.po_id, l.sku, l.product_name, l.qty
    from unnest(array[v_po01_id, v_po02_id, v_po03_id]) as p(po_id)
   cross join (
     select (line->>'sku') as sku,
            (line->>'product_name') as product_name,
            (line->>'qty')::numeric as qty
       from jsonb_array_elements(v_lines) as line
   ) as l;

  return jsonb_build_object(
    'master_ref', v_master_ref,
    'po_ids', jsonb_build_array(v_po01_id, v_po02_id, v_po03_id),
    'po_numbers', jsonb_build_array(v_po01_number, v_po02_number, v_po03_number)
  );
end;
$$;

-- service_role/postgres only — never anon, never authenticated. The engine
-- calls this through the admin client server-side (engine-data.ts).
revoke all on function public.mrp_draft_po_chain(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.mrp_draft_po_chain(jsonb, boolean) to service_role;
