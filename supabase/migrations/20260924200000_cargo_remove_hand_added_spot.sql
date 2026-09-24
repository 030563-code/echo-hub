-- Taking a shipment added by mistake back off the board.
--
-- Dean, 24 Sep 2026: "i also cant delete a shipment if I make one by accident."
--
-- A SPOT ID typed into Add a shipment is kept in cargo_tracked_spot, and every refresh after that
-- writes its Cargo Partner copy to cargo_shipment. Nothing took either back out, and the refresh
-- only ever adds. This removes one, in one transaction, and only when nothing else knows it:
--
--   in_sheet            Dave's sheet lists it (eb_operations.shipments): the next refresh would
--                       bring it straight back, and it is Dave's to remove there.
--   on_order            a Hub purchase order resolved to it (po_shipments): the same.
--   customs_bill        a Nippon bill is matched to it.
--   commercial_invoice  a commercial invoice names it.
--   in_transit_stock    shipment_contents counts it as stock on its way (the MRP reads that).
--   lead_time           the lead time statistics were worked from it.
--   shared              somebody gave a customer a tracking link that still works.
--
-- Anything of those means the shipment is in real use rather than a slip of the keyboard. What
-- goes: the Hub's own shipment for that SPOT with its contents, invoices and costs (cascade), and
-- the Cargo Partner copy with its containers, route, milestones, references and dead links
-- (cascade). Cargo Partner itself is never told: this is only the Hub's copy.
--
-- Returns 'removed', or the reason it would not. Service role only; the gated action in
-- src/app/actions/cargo/track.ts checks the caller's depots first.

create or replace function public.cargo_remove_hand_added_spot(p_spot_id text)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_spot_id is null or p_spot_id !~ '^[0-9]{6,12}$' then
    return 'not_hand_added';
  end if;
  perform 1 from public.cargo_tracked_spot where spot_id = p_spot_id for update;
  if not found then
    return 'not_hand_added';
  end if;

  if exists (select 1 from eb_operations.shipments where btrim(spot_id) = p_spot_id) then return 'in_sheet'; end if;
  if exists (select 1 from public.po_shipments where spot_id = p_spot_id) then return 'on_order'; end if;
  if exists (select 1 from public.customs_bills where spot_id = p_spot_id) then return 'customs_bill'; end if;
  if exists (select 1 from public.commercial_invoices where shipment_spot_id = p_spot_id) then return 'commercial_invoice'; end if;
  if exists (select 1 from public.shipment_contents where spot_id = p_spot_id) then return 'in_transit_stock'; end if;
  if exists (select 1 from public.mrp_lead_time_actuals where spot_id = p_spot_id) then return 'lead_time'; end if;
  if exists (
    select 1 from public.cargo_share_link
    where spot_id = p_spot_id and revoked_at is null and (expires_at is null or expires_at > now())
  ) then
    return 'shared';
  end if;

  delete from public.transport_shipment where spot_id = p_spot_id;
  delete from public.cargo_shipment where spot_id = p_spot_id;
  delete from public.cargo_tracked_spot where spot_id = p_spot_id;
  return 'removed';
end;
$$;

comment on function public.cargo_remove_hand_added_spot(text) is
  'Takes a SPOT ID added by hand back off the board, with everything the Hub holds for it, unless anything else knows it. Returns removed or the reason.';

revoke all on function public.cargo_remove_hand_added_spot(text) from public, anon, authenticated;
grant execute on function public.cargo_remove_hand_added_spot(text) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.cargo_remove_hand_added_spot(text)', 'execute')
     or has_function_privilege('authenticated', 'public.cargo_remove_hand_added_spot(text)', 'execute') then
    raise exception 'anon or authenticated can still run cargo_remove_hand_added_spot';
  end if;
end $$;
