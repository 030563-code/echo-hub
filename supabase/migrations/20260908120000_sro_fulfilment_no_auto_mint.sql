-- Approving the SRO leg must stop there, so somebody can decide how to fulfil it.
--
-- Today approving EB_GROUP_TO_SRO immediately inserts the SRO_TO_SUPPLIER child,
-- which is a purchase order on Bamida. That decides, silently and on the spot,
-- the exact question SRO is supposed to answer: fulfil this from stock we
-- already hold in Kosice, or manufacture it. The Hub cannot offer that choice
-- while the choice has already been made by a trigger.
--
-- So EB_GROUP_TO_SRO now mints nothing. The SRO_TO_SUPPLIER child is raised only
-- when someone chooses Manufacture; choosing stock marks the leg
-- fulfilling_from_stock and raises nothing at all. Both statuses are already
-- allowed by the purchase_orders CHECK, so nothing else moves.
--
-- Everything else is unchanged from 20260714000000_hub_approve_po_leg_atomic:
-- the capability check, the FOR UPDATE lock that makes a racing approver lose
-- cleanly, DEPOT_TO_EB_GROUP still raising the SRO leg, the reference carry
-- through, and the line copy. The unique index on (parent_po_id, leg) stays as
-- the concurrency backstop, and now also stops a second Manufacture press from
-- raising a second Bamida order.
--
-- 'awaiting_fulfilment' is returned so the approval can say what happens next
-- rather than going quiet: the leg is approved and is waiting on a decision,
-- which is not the same thing as the chain being finished.

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
  v_awaiting  boolean := false;
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
    -- Stop here. SRO chooses stock or manufacture; the Bamida order is raised by
    -- that choice, not by this approval.
    v_next_leg := null;
    v_awaiting := true;
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
    'next_leg', v_next_leg,
    'awaiting_fulfilment', v_awaiting
  );
end $$;

revoke execute on function public.hub_approve_po_leg(uuid, text, uuid) from public, anon;
grant  execute on function public.hub_approve_po_leg(uuid, text, uuid) to authenticated;
