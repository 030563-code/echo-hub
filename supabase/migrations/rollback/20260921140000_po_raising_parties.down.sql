-- Undo 20260921140000_po_raising_parties.sql.
--
-- Restores the three functions to their 20260914140000 definitions, drops the
-- two new sequences and removes the three delivery addresses this added.
--
-- NUMBERS ALREADY MINTED ARE KEPT. An EBUK8001 or a standalone EBSRO8001-1 is a
-- purchase order number Xero holds; taking it out of the Hub would not take it
-- out of Xero. After this runs those orders keep their numbers and no new one
-- can be minted in either series, which is the intended state.

begin;

-- The functions first, so nothing can call a sequence that is about to go.
create or replace function public.hub_po_prefix_for_depot(p_depot text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
begin
  v_prefix := case p_depot
    when 'US-BAL' then 'EBUSA'
    when 'US-SBD' then 'EBUSA'
    when 'CA-HAM' then 'EBCAN'
    when 'EU-FR' then 'EBFRA'
    when 'AU-SYD' then 'EBAUS'
  end;
  if v_prefix is null then
    raise exception 'Depot % has no purchase order number series. Depot orders can be raised for US-BAL, US-SBD, CA-HAM, EU-FR and AU-SYD.',
      coalesce(nullif(p_depot, ''), '(blank)')
      using hint = 'Add the depot to public.hub_po_prefix_for_depot in a migration before raising orders for it.';
  end if;
  return v_prefix;
end;
$$;

revoke all on function public.hub_po_prefix_for_depot(text) from public, anon, authenticated;

create or replace function public.hub_mint_po_number(p_leg text, p_from text, p_parent_po_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix     text;
  v_parent_leg text;
  v_parent_no  text;
  v_digits     text;
begin
  if p_leg = 'DEPOT_TO_EB_GROUP' then
    v_prefix := public.hub_po_prefix_for_depot(p_from);
    if v_prefix = 'EBUSA' then
      return v_prefix || nextval('public.po_number_seq_ebusa');
    elsif v_prefix = 'EBCAN' then
      return v_prefix || nextval('public.po_number_seq_ebcan');
    elsif v_prefix = 'EBFRA' then
      return v_prefix || nextval('public.po_number_seq_ebfra');
    elsif v_prefix = 'EBAUS' then
      return v_prefix || nextval('public.po_number_seq_ebaus');
    end if;
    raise exception 'Series % has no sequence behind it.', v_prefix;
  end if;

  if p_leg = 'EB_GROUP_TO_SRO' then
    return 'EBGRP' || nextval('public.po_number_seq_ebgrp');
  end if;

  if p_leg in ('SRO_TO_SUPPLIER', 'SRO_TO_CARGO') then
    if p_parent_po_id is null then
      raise exception 'A % order takes its number from its SRO order, and this one has no parent_po_id.', p_leg;
    end if;

    select po.leg, po.po_number
      into v_parent_leg, v_parent_no
      from public.purchase_orders po
     where po.id = p_parent_po_id;
    if not found then
      raise exception 'The order behind this % order cannot be used to number it.', p_leg;
    end if;

    v_digits := substring(v_parent_no from '^EBGRP([0-9]+)$');
    if v_parent_leg = 'EB_GROUP_TO_SRO' and v_digits is not null then
      return 'EBSRO' || v_digits || case p_leg when 'SRO_TO_SUPPLIER' then '-1' else '-2' end;
    end if;

    raise warning 'Purchase order % (leg %) has no EBGRP number to derive from, so its % order takes a PO- number instead of an EBSRO one.',
      v_parent_no, v_parent_leg, p_leg;
    return public.generate_po_number();
  end if;

  raise exception 'No purchase order number series for leg %.', coalesce(nullif(p_leg, ''), '(blank)');
end;
$$;

revoke all on function public.hub_mint_po_number(text, text, uuid) from public, anon, authenticated;

create or replace function public.po_guard_number_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated'
     and (new.po_number is distinct from old.po_number
          or new.master_ref is distinct from old.master_ref) then
    raise exception 'A purchase order number cannot be changed.';
  end if;

  if new.po_number is distinct from old.po_number
     and old.po_number ~ '^(EB(USA|CAN|FRA|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$' then
    raise exception 'Purchase order % carries the number Xero holds and cannot be changed once the order exists.', old.po_number;
  end if;

  if new.master_ref is distinct from old.master_ref
     and old.master_ref ~ '^MR-(EB(USA|CAN|FRA|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$' then
    raise exception 'Purchase order chain % carries the number Xero holds and cannot be changed once the order exists.', old.master_ref;
  end if;

  return new;
end;
$$;

revoke all on function public.po_guard_number_update() from public, anon, authenticated;

drop sequence if exists public.po_number_seq_ebuk, public.po_number_seq_ebsro;

-- GB-BSE is NOT removed: Dean asked for that row on its own ("add gb-bse delivery
-- address same as group") and it was inserted live before this migration ran,
-- so the migration's own insert was a no-op for it.
delete from public.po_delivery_addresses where entity in ('EU-FR', 'AU-SYD');

-- The postcode correction is NOT reverted. It was a correction, and putting a
-- wrong postcode back on a delivery address would be a fresh mistake rather
-- than an undo.

commit;
