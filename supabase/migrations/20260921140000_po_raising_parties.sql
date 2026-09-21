-- Four more parties can raise a purchase order: France, the UK, Group and s.r.o.
--
-- Written into pending/ first (Dean, 21 Sep 2026, "Lets first develop on
-- localhost and not on prod"), dry-run on korylyniwsqtsvzuzydg inside
-- begin/rollback with a probe select, then applied live via MCP apply_migration
-- on 21 Sep 2026 at Dean's word ("do 1 and 2 and 3 also"). This file is the repo
-- record. Never db push.
--
-- Dean, 21 Sep 2026: "Add this raising depots in the purchase orders, EU-FR,
-- GB-BSE, EB-GROUP, EB-SRO ... add the delivery addresses in supabase GB-BSE is
-- also 118a newmarket rd ... ensure the correct purchase orders are raised in
-- the correct Xero organisations mapped to the correct xero_item_codes".
--
-- WHAT WAS ALREADY TRUE, and what was not:
--   EU-FR    had a series (EBFRA) and a Xero tenant, and was never offered.
--   GB-BSE   had neither. Both are added here.
--   EB-GROUP already mints EBGRP with no parent, so it can raise today.
--   EB-SRO   could not: hub_mint_po_number REFUSED a SRO_TO_SUPPLIER order with
--            no parent_po_id, because every one so far came from a Group order.
--            An s.r.o. order raised on its own account is ordinary rather than
--            exceptional (the manufacturer's board is full of direct orders for
--            Takamiya, Heras and Cision), so it gets its own series.
--
-- 🔴 THE LIVE FAULT THIS CLOSES. n8n workflow Fz7xXgifva5n548u chose the Xero
-- item code column with `let codeCol = "code_usa_balt"` and three ifs, and the
-- tenant with `from_entity === 'CA-HAM' ? Canada : USA`. EU-FR already had a
-- number series, so the first French order raised would have been created in the
-- UNITED STATES Xero organisation carrying US Baltimore item codes, silently.
-- The Hub half is src/lib/po-raising.ts; the n8n half must be published in the
-- same sitting as this migration or the fault simply moves.

begin;

-- ---------------------------------------------------------------------------
-- 1. Two new number series.
-- ---------------------------------------------------------------------------
-- Same shape as the five from 20260914140000: start at 8001, wound past any
-- number the prefix already carries so a re-apply cannot re-issue a number that
-- is already a purchase order number in Xero, is_called false so the stored
-- value IS the next one out.
create sequence public.po_number_seq_ebuk as bigint start with 8001 minvalue 8001 no cycle;
create sequence public.po_number_seq_ebsro as bigint start with 8001 minvalue 8001 no cycle;

select setval('public.po_number_seq_ebuk', greatest(8001, coalesce((select max(substring(po_number from '^EBUK([0-9]+)$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBUK[0-9]+$'), 8001)), false);
-- s.r.o.'s standalone series shares its shape with the derived one
-- (EBSRO<n>-1), so it must be wound past BOTH: an EBSRO8123-1 derived from
-- Group order EBGRP8123 would otherwise be re-minted here as a standalone.
select setval('public.po_number_seq_ebsro', greatest(8001, coalesce((select max(substring(po_number from '^EBSRO([0-9]+)-[123]$')::bigint) + 1 from public.purchase_orders where po_number ~ '^EBSRO[0-9]+-[123]$'), 8001)), false);

revoke all on sequence public.po_number_seq_ebuk, public.po_number_seq_ebsro from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. GB-BSE gets a series.
-- ---------------------------------------------------------------------------
-- Still no else branch: an unmapped depot refuses rather than borrowing another
-- country's prefix, which is the whole point of the function.
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
    when 'GB-BSE' then 'EBUK'
    when 'AU-SYD' then 'EBAUS'
  end;
  if v_prefix is null then
    raise exception 'Depot % has no purchase order number series. Depot orders can be raised for US-BAL, US-SBD, CA-HAM, EU-FR, GB-BSE and AU-SYD.',
      coalesce(nullif(p_depot, ''), '(blank)')
      using hint = 'Add the depot to public.hub_po_prefix_for_depot in a migration before raising orders for it.';
  end if;
  return v_prefix;
end;
$$;

revoke all on function public.hub_po_prefix_for_depot(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Minting: EBUK, and an s.r.o. order that has no parent.
-- ---------------------------------------------------------------------------
-- Everything else is byte-identical to 20260914140000. The one behavioural
-- change is the parentless SRO_TO_SUPPLIER branch: it used to raise, now it
-- takes EBSRO<seq>-1 from its own series. A SRO_TO_CARGO order still refuses
-- without a parent, because a shipping order with nothing to ship is a mistake
-- rather than a direct purchase.
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
    elsif v_prefix = 'EBUK' then
      return v_prefix || nextval('public.po_number_seq_ebuk');
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
      -- s.r.o. buying on its own account. Its manufacturing order takes the
      -- standalone series and keeps the -1 shape, so every EBSRO number still
      -- says what the document is for. A shipping order still needs something
      -- to ship.
      if p_leg = 'SRO_TO_SUPPLIER' then
        return 'EBSRO' || nextval('public.po_number_seq_ebsro') || '-1';
      end if;
      raise exception 'A % order takes its number from its SRO order, and this one has no parent_po_id.', p_leg;
    end if;

    select po.leg, po.po_number
      into v_parent_leg, v_parent_no
      from public.purchase_orders po
     where po.id = p_parent_po_id;
    -- No uuid in any message from here down. The caller supplied the id and
    -- learns nothing from having it read back, and a message that told a
    -- stranger whether an id existed would be a free row count of the table.
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

-- ---------------------------------------------------------------------------
-- 4. The rename guard has to know EBUK is a scheme number.
-- ---------------------------------------------------------------------------
-- Without this an EBUK order could be renamed by the service role, which is
-- exactly what the guard exists to stop (n8n PATCHing Xero's own number back
-- over the Hub's). isNewSchemePoNumber in src/lib/po-number.ts carries the same
-- pattern and tests/unit/po-numbering-schema-coherence.test.ts pins them to
-- each other sample by sample.
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
     and old.po_number ~ '^(EB(USA|CAN|FRA|UK|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$' then
    raise exception 'Purchase order % carries the number Xero holds and cannot be changed once the order exists.', old.po_number;
  end if;

  if new.master_ref is distinct from old.master_ref
     and old.master_ref ~ '^MR-(EB(USA|CAN|FRA|UK|AUS|GRP)[0-9]+|EBSRO[0-9]+-[123])$' then
    raise exception 'Purchase order chain % carries the number Xero holds and cannot be changed once the order exists.', old.master_ref;
  end if;

  return new;
end;
$$;

revoke all on function public.po_guard_number_update() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Delivery addresses.
-- ---------------------------------------------------------------------------
-- Dean, 21 Sep 2026: "add the delivery addresses in supabase GB-BSE is also
-- 118a newmarket rd". The UK warehouse is where Group's goods land too, which
-- is why EB-GROUP already carried this address.
--
-- 🔴 The postcode on the existing EB-GROUP row says IP33 3TG. Two of Echo
-- Barrier's own documents say IP33 3TF: the packing list PL-A UK 10.08.2026 and
-- the EU export accompanying document EAD_26SK626302607913B6. This corrects it
-- and leaves the rest of that row alone. If 3TG is right, revert this one
-- statement and tell whoever wrote those two documents.
update public.po_delivery_addresses
   set address = replace(address, 'IP33 3TG', 'IP33 3TF')
 where entity in ('EB-GROUP', 'GB-BSE') and address like '%IP33 3TG%';

-- 🔴 NOT `on conflict do nothing`. po_delivery_addresses has exactly one unique
-- index and it is the primary key on `id`, so ON CONFLICT could never fire and
-- a second apply would silently give every depot a duplicate address in the
-- dropdown. `where not exists` is what makes this re-runnable.
--
-- 🔴 The EU-FR and AU-SYD rows are PLACEHOLDERS, in the same shape the Canadian
-- and Slovak rows have carried since they were created. A delivery address is
-- printed on the order the manufacturer packs to, so an invented one is worse
-- than a visible gap.
insert into public.po_delivery_addresses (entity, label, address, active)
select v.entity, v.label, v.address, true
from (values
  -- Dean, 21 Sep 2026: "add gb-bse delivery address same as group". Inserted
  -- live that day as a copy of the EB-GROUP row, so on apply this line is a
  -- no-op and the postcode correction above covers both rows together.
  ('GB-BSE', 'UK depot, Bury St Edmunds', E'118A Newmarket Rd, Bury Saint Edmunds IP33 3TF, United Kingdom\n'),
  ('EU-FR', 'France depot', '- confirm ship-to address -'),
  ('AU-SYD', 'Australia depot, Sydney', '- confirm ship-to address -')
) as v(entity, label, address)
where not exists (
  select 1 from public.po_delivery_addresses a
   where a.entity = v.entity and a.label = v.label
);

commit;
