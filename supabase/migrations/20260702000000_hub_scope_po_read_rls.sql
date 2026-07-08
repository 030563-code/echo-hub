-- Scope PO-family SELECT policies to a capability (was `USING (true)` for any
-- authenticated user → a logged-in user with NO PO-related capability, e.g. a
-- quotes-only or invoice-only user, could read every PO / line / shipment /
-- attachment via the raw PostgREST API). Tighten reads to the union of the
-- capabilities whose modules legitimately read POs:
--   po.view / po.create / po.approve / po.receive  (the PO + receiving pages)
--   bom.view / bom.edit                            (the BOM explosion reads POs+lines)
--   transport.view                                 (the shipment resolver reads POs)
--   mrp.view                                       (the MRP dashboard reads POs)
-- admin / super-admin are folded in by is_super_admin(). WRITE policies and the
-- service_role policies are untouched — n8n's service_role writes are unaffected.
--
-- A single SECURITY DEFINER helper keeps the predicate in one place (add a new
-- PO-reading module → update here only) and pins search_path (defence-in-depth,
-- also clears the function_search_path_mutable advisor for this function).

create or replace function public.can_read_po()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select public.is_super_admin()
      or exists (
        select 1 from public.user_capabilities uc
        where uc.user_id = auth.uid()
          and uc.capability in (
            'po.view','po.create','po.approve','po.receive',
            'bom.view','bom.edit','transport.view','mrp.view','admin'
          )
      );
$$;

grant execute on function public.can_read_po() to authenticated;

-- purchase_orders
drop policy if exists "Authenticated users can read purchase_orders" on public.purchase_orders;
create policy "hub: read purchase_orders (scoped)"
  on public.purchase_orders for select to authenticated
  using ( (select public.can_read_po()) );

-- purchase_order_lines
drop policy if exists "Authenticated users can read purchase_order_lines" on public.purchase_order_lines;
create policy "hub: read purchase_order_lines (scoped)"
  on public.purchase_order_lines for select to authenticated
  using ( (select public.can_read_po()) );

-- po_shipments (was `hub: read po shipments` USING true)
drop policy if exists "hub: read po shipments" on public.po_shipments;
create policy "hub: read po shipments (scoped)"
  on public.po_shipments for select to authenticated
  using ( (select public.can_read_po()) );

-- po_attachments (was `hub: read attachments` USING true)
drop policy if exists "hub: read attachments" on public.po_attachments;
create policy "hub: read attachments (scoped)"
  on public.po_attachments for select to authenticated
  using ( (select public.can_read_po()) );
