-- Atomic PO-leg approval. Replaces decide-po's three separate writes (approve →
-- insert child → copy lines), which could half-fail and strand an approved leg
-- with no successor, and which never set the child's reference_po_number (root
-- cause of the broken n8n reference carry-through + the SRO parent-lookup crash).
--
-- Concurrency-safe: SELECT ... FOR UPDATE serialises racing approvers; a loser
-- sees status <> 'requested' and returns ok=false → the app reports "already
-- decided" instead of silently raising a duplicate next-tier PO + double-firing
-- Xero (audit finding #2). Sets reference_po_number = the approved leg's own
-- po_number on the child, so the reference flows Hub-side and n8n gets it in the
-- webhook payload (no fragile lookup needed).
create or replace function public.hub_approve_po_leg(p_po_id uuid, p_label text, p_uid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po        public.purchase_orders%rowtype;
  v_next_leg  text;
  v_next_from text;
  v_next_to   text;
  v_child_id  uuid;
  v_child_num text;
begin
  if not public.has_capability('po.approve') then
    raise exception 'forbidden: requires po.approve';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_po.source <> 'hub' or v_po.status <> 'requested'
     or v_po.leg not in ('DEPOT_TO_EB_GROUP','EB_GROUP_TO_SRO','SRO_TO_SUPPLIER') then
    return jsonb_build_object('ok', false, 'reason', 'not_approvable', 'status', v_po.status);
  end if;

  update public.purchase_orders
     set status = 'approved', approved_by = p_label, approved_by_uid = p_uid, approved_at = now()
   where id = p_po_id;

  if v_po.leg = 'DEPOT_TO_EB_GROUP' then
    v_next_leg := 'EB_GROUP_TO_SRO'; v_next_from := 'EB-GROUP'; v_next_to := 'EB-SRO';
  elsif v_po.leg = 'EB_GROUP_TO_SRO' then
    v_next_leg := 'SRO_TO_SUPPLIER'; v_next_from := 'EB-SRO'; v_next_to := 'SUPPLIER';
  else
    v_next_leg := null; -- SRO_TO_SUPPLIER is terminal
  end if;

  if v_next_leg is not null then
    insert into public.purchase_orders
      (parent_po_id, leg, from_entity, to_entity, status, source,
       requested_by, reference_po_number, delivery_address, notes)
    values
      (v_po.id, v_next_leg, v_next_from, v_next_to, 'requested', 'hub',
       p_label, v_po.po_number, v_po.delivery_address, v_po.notes)
    returning id, po_number into v_child_id, v_child_num;

    insert into public.purchase_order_lines
      (po_id, sku, product_name, product_family, quantity, hs_code, unit_price)
    select v_child_id, sku, product_name, product_family, quantity, hs_code, unit_price
    from public.purchase_order_lines where po_id = v_po.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'leg', v_po.leg,
    'po_number', v_po.po_number,
    'reference_po_number', v_po.reference_po_number,
    'master_ref', v_po.master_ref,
    'from_entity', v_po.from_entity,
    'to_entity', v_po.to_entity,
    'parent_po_id', v_po.parent_po_id,
    'delivery_address', v_po.delivery_address,
    'child_id', v_child_id,
    'child_po_number', v_child_num,
    'next_leg', v_next_leg
  );
end $$;

revoke execute on function public.hub_approve_po_leg(uuid, text, uuid) from public, anon;
grant  execute on function public.hub_approve_po_leg(uuid, text, uuid) to authenticated;

-- Concurrency backstop: at most one child per (parent, leg). Also prevents a
-- duplicate SRO_TO_CARGO from a double cargo-raise. No existing dupes (verified).
create unique index if not exists purchase_orders_parent_leg_uidx
  on public.purchase_orders (parent_po_id, leg)
  where parent_po_id is not null;
