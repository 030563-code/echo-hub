-- Undo 20260922210000_group_and_sro_raise_their_own_orders.
--
-- Puts the policy back to the depot leg only, exactly as 20260615000000 wrote it.
-- Group and s.r.o. can then no longer raise their own orders and the Hub returns
-- "Failed to raise the purchase order. Please try again." for them again, so run
-- this only if widening the policy turns out to be wrong, not to tidy up.
--
-- Nothing else is undone. Orders raised by Group or s.r.o. while the wider policy
-- was in force stay exactly as they are: this is a write gate, not a constraint,
-- and rows already written are none of its business.

drop policy if exists "hub: raise PO" on public.purchase_orders;

create policy "hub: raise PO"
  on public.purchase_orders for insert to authenticated
  with check (
    (select public.has_capability('po.create'))
    and leg = 'DEPOT_TO_EB_GROUP'
    and to_entity = 'EB-GROUP'
    and status = 'requested'
    and parent_po_id is null
    and source = 'hub'
    and requested_by_uid = (select auth.uid())
    and (
      (select public.is_super_admin())
      or 'ALL' = any (coalesce((select allowed_depots from public.profiles where id = (select auth.uid())), array[]::text[]))
      or from_entity = any (coalesce((select allowed_depots from public.profiles where id = (select auth.uid())), array[]::text[]))
    )
  );

do $$
declare
  chk text;
begin
  select pg_get_expr(polwithcheck, polrelid) into chk
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'purchase_orders' and p.polname = 'hub: raise PO';
  if chk is null then
    raise exception 'the raise policy did not survive the rollback';
  end if;
  if position('EB_GROUP_TO_SRO' in chk) > 0 or position('SRO_TO_SUPPLIER' in chk) > 0 then
    raise exception 'the widened legs survived the rollback';
  end if;
end $$;
