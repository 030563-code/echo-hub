-- ============================================================================
-- mrp_draft_po_chain v2 — quiet mode without session_replication_role.
--
-- v1 suppressed the purchase_orders webhook triggers with
-- `set local session_replication_role = replica`, which works from a direct
-- postgres session (supautils whitelist) but is DENIED when the function runs
-- SECURITY DEFINER under a PostgREST service_role call — exactly how the
-- engine invokes it ("permission denied to set parameter", observed live
-- 2026-08-09).
--
-- v2 lets every trigger fire normally and instead scrubs the side effect at
-- its buffer: net.http_post only QUEUES a row in net.http_request_queue; the
-- pg_net worker cannot see uncommitted rows, so deleting our own queued
-- webhook rows before commit means they are never sent. The delete is
-- targeted by url + the payload's po_number (prefix match on this chain's
-- numbers), so a concurrent real PO's webhook can never be swept. The
-- BEFORE-INSERT po_number generator now runs too — harmless, it only fills
-- blank po_number/master_ref and this function always supplies both.
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
  select id into v_existing_id
    from public.purchase_orders
   where po_number = v_po01_number;

  if found then
    return jsonb_build_object('skipped', 'exists', 'master_ref', v_master_ref);
  end if;

  insert into public.purchase_orders
    (po_number, master_ref, leg, from_entity, to_entity, parent_po_id,
     status, source, requested_by, notes)
  values
    (v_po01_number, v_master_ref, 'DEPOT_TO_EB_GROUP', v_depot, 'EB-GROUP', null,
     'requested', 'hub', 'mrp-engine', v_rationale)
  returning id into v_po01_id;

  insert into public.purchase_orders
    (po_number, master_ref, leg, from_entity, to_entity, parent_po_id,
     status, source, requested_by, notes)
  values
    (v_po02_number, v_master_ref, 'EB_GROUP_TO_SRO', 'EB-GROUP', 'EB-SRO', v_po01_id,
     'requested', 'hub', 'mrp-engine', v_rationale)
  returning id into v_po02_id;

  insert into public.purchase_orders
    (po_number, master_ref, leg, from_entity, to_entity, parent_po_id,
     status, source, requested_by, notes, lifecycle_stage)
  values
    (v_po03_number, v_master_ref, 'SRO_TO_SUPPLIER', 'EB-SRO', 'SUPPLIER', v_po02_id,
     'requested', 'hub', 'mrp-engine', v_rationale, 'sro')
  returning id into v_po03_id;

  insert into public.purchase_order_lines (po_id, sku, product_name, quantity)
  select p.po_id, l.sku, l.product_name, l.qty
    from unnest(array[v_po01_id, v_po02_id, v_po03_id]) as p(po_id)
   cross join (
     select (line->>'sku') as sku,
            (line->>'product_name') as product_name,
            (line->>'qty')::numeric as qty
       from jsonb_array_elements(v_lines) as line
   ) as l;

  -- Quiet mode: unsend this chain's queued webhooks (see header).
  if p_quiet then
    delete from net.http_request_queue q
     where q.url like 'https://medes.app.n8n.cloud/webhook/po-phase%'
       and convert_from(q.body, 'UTF8')::jsonb->>'po_number' like v_prefix || '-%';
  end if;

  return jsonb_build_object(
    'master_ref', v_master_ref,
    'po_ids', jsonb_build_array(v_po01_id, v_po02_id, v_po03_id),
    'po_numbers', jsonb_build_array(v_po01_number, v_po02_number, v_po03_number)
  );
end;
$$;

revoke all on function public.mrp_draft_po_chain(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.mrp_draft_po_chain(jsonb, boolean) to service_role;
