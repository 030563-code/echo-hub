-- Rollback of 20260913101000_stock_warm_start_refill: restores the
-- three-leg-only function from 20260911130000_stock_warm_start_rpc.sql verbatim
-- (a blank depot is an error again). Chains already loaded as refills stay.

create or replace function public.hub_warm_start_po_chain(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stage      text := p->>'stage';
  v_depot      text := p->>'depot';
  v_note       text := 'Warm start from s.r.o. list, ' || to_char(now(), 'YYYY-MM-DD') || coalesce(': ' || nullif(p->>'note', ''), '');
  v_lines      jsonb := coalesce(p->'lines', '[]'::jsonb);
  v_depot_no   text := nullif(p->>'depot_po_number', '');
  v_sro_no     text := nullif(p->>'sro_po_number', '');
  v_bamida_no  text := nullif(p->>'bamida_po_number', '');
  v_sro_status text;
  v_sro_type   text;
  v_depot_id   uuid;
  v_sro_id     uuid;
  v_bamida_id  uuid;
  v_taken      text;
begin
  if v_stage not in ('sent', 'in_production', 'finished', 'ready_stock') then
    raise exception 'hub_warm_start_po_chain: stage must be sent, in_production, finished or ready_stock (got %)', v_stage;
  end if;
  if v_depot is null or v_depot = '' then
    raise exception 'hub_warm_start_po_chain: depot is required';
  end if;
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'hub_warm_start_po_chain: at least one line is required';
  end if;

  -- Never overwrite: any supplied number already in the table stops the call.
  select po_number into v_taken
    from public.purchase_orders
   where po_number in (v_depot_no, v_sro_no, v_bamida_no)
   limit 1;
  if v_taken is not null then
    return jsonb_build_object('ok', false, 'reason', 'exists', 'po_number', v_taken);
  end if;

  if v_stage = 'ready_stock' then
    v_sro_status := 'ready_for_shipment'; v_sro_type := 'stock';
  elsif v_stage = 'finished' then
    v_sro_status := 'ready_for_shipment'; v_sro_type := 'manufacture';
  else
    v_sro_status := 'in_manufacturing'; v_sro_type := 'manufacture';
  end if;

  -- Depot leg: approved, so the depot's inbound figure shows it.
  insert into public.purchase_orders
    (po_number, leg, from_entity, to_entity, status, source, requested_by, approved_by, approved_at, notes)
  values
    (v_depot_no, 'DEPOT_TO_EB_GROUP', v_depot, 'EB-GROUP', 'approved', 'hub', 'warm-start', 'warm-start', now(), v_note)
  returning id into v_depot_id;

  -- The SRO order: the Group's order on s.r.o., carrying the fulfilment decision.
  insert into public.purchase_orders
    (po_number, parent_po_id, leg, from_entity, to_entity, status, fulfilment_type, source, requested_by, approved_by, approved_at, reference_po_number, notes)
  values
    (v_sro_no, v_depot_id, 'EB_GROUP_TO_SRO', 'EB-GROUP', 'EB-SRO', v_sro_status, v_sro_type, 'hub', 'warm-start', 'warm-start', now(), v_depot_no, v_note)
  returning id into v_sro_id;

  -- Lines on the depot and SRO legs.
  insert into public.purchase_order_lines (po_id, sku, product_name, quantity)
  select v_depot_id, l->>'sku', nullif(l->>'product_name', ''), (l->>'quantity')::integer
    from jsonb_array_elements(v_lines) as l;
  insert into public.purchase_order_lines (po_id, sku, product_name, quantity)
  select v_sro_id, l->>'sku', nullif(l->>'product_name', ''), (l->>'quantity')::integer
    from jsonb_array_elements(v_lines) as l;

  -- The Bamida order, unless the order came off the shelf.
  if v_stage <> 'ready_stock' then
    insert into public.purchase_orders
      (po_number, parent_po_id, leg, from_entity, to_entity, status, source, requested_by, approved_by, approved_at, reference_po_number, notes)
    values
      (v_bamida_no, v_sro_id, 'SRO_TO_SUPPLIER', 'EB-SRO', 'SUPPLIER', 'approved', 'hub', 'warm-start', 'warm-start', now(), v_sro_no, v_note)
    returning id into v_bamida_id;

    insert into public.purchase_order_lines (po_id, sku, product_name, quantity)
    select v_bamida_id, l->>'sku', nullif(l->>'product_name', ''), (l->>'quantity')::integer
      from jsonb_array_elements(v_lines) as l;

    insert into public.po_manufacturing
      (po_id, sent_at, sent_to, sent_was_test, est_start, est_finish, finished_at)
    values
      (v_bamida_id,
       coalesce((p->>'sent_at')::timestamptz, now()),
       '{}'::text[],
       false,
       (p->>'est_start')::date,
       (p->>'est_finish')::date,
       case when v_stage = 'finished' then coalesce((p->>'finished_at')::timestamptz, now()) else null end);
  end if;

  return jsonb_build_object(
    'ok', true,
    'depot_po', (select po_number from public.purchase_orders where id = v_depot_id),
    'sro_po', (select po_number from public.purchase_orders where id = v_sro_id),
    'bamida_po', (select po_number from public.purchase_orders where id = v_bamida_id),
    'master_ref', (select master_ref from public.purchase_orders where id = v_depot_id));
end
$$;

revoke all on function public.hub_warm_start_po_chain(jsonb) from public, anon, authenticated;
grant execute on function public.hub_warm_start_po_chain(jsonb) to service_role;
