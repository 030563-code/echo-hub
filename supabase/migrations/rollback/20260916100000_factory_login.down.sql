-- Rollback of 20260916100000_factory_login.sql.
--
-- Read this before running it. It reopens 32 tables to every signed-in account,
-- and while self-signup is on at the Auth provider "every signed-in account"
-- means anybody who found the anon key in the browser bundle. If you are here
-- because the factory login is being withdrawn, the smaller move is to delete
-- the two user_capabilities rows and leave the containment in place.
--
-- Two things are deliberately NOT restored:
--   * anon and authenticated do not get INSERT, UPDATE, DELETE or TRUNCATE on
--     product_code_master back. That was a hole, not a feature.
--   * TRUNCATE, REFERENCES and TRIGGER stay revoked across public, as do the
--     write verbs on view_sku_demand. PostgREST cannot use the first three and
--     RLS does not restrain TRUNCATE.

begin;

-- 1. The thirty read policies, back to answering anybody signed in.
do $$
declare p record;
begin
  for p in select * from (values
    ('account_registry', 'Authenticated users can read account_registry'),
    ('bom_registry', 'Authenticated users can read bom_registry'),
    ('capabilities', 'Capabilities readable by authenticated'),
    ('entities', 'hub: read entities'),
    ('item_catalog', 'picklist readable by authenticated'),
    ('manufacturing_stocktake_lines', 'Authenticated users can read manufacturing_stocktake_lines'),
    ('manufacturing_stocktakes', 'Authenticated users can read manufacturing_stocktakes'),
    ('mrp_bom_component', 'hub: read mrp_bom_component'),
    ('mrp_bom_map', 'hub: read mrp_bom_map'),
    ('mrp_bom_product', 'hub: read mrp_bom_product'),
    ('mrp_bom_sku_map', 'hub: read mrp_bom_sku_map'),
    ('mrp_buffer_profile', 'hub: read mrp_buffer_profile'),
    ('mrp_buffer_status_daily', 'hub: read mrp_buffer_status_daily'),
    ('mrp_ddsop_log', 'hub: read mrp_ddsop_log'),
    ('mrp_demand_events', 'authenticated_read_demand_events'),
    ('mrp_lead_time_actuals', 'hub: read mrp_lead_time_actuals'),
    ('mrp_spike_register', 'hub: read mrp_spike_register'),
    ('mrp_stage_weights', 'hub: read mrp_stage_weights'),
    ('onix_sku_mapping', 'Authenticated users can read onix_sku_mapping'),
    ('onix_warehouse_mapping', 'Authenticated users can read onix_warehouse_mapping'),
    ('po_delivery_addresses', 'picklist readable by authenticated'),
    ('po_hs_codes', 'picklist readable by authenticated'),
    ('po_line_receipts', 'hub: read receipts'),
    ('po_product_catalog', 'picklist readable by authenticated'),
    ('po_suppliers', 'picklist readable by authenticated'),
    ('product_depot_mapping', 'Authenticated can read product_depot_mapping'),
    ('shipment_contents', 'Authenticated users can read shipment_contents'),
    ('shipment_events', 'Authenticated users can read shipment_events'),
    ('shipments', 'Authenticated users can read shipments'),
    ('warehouse_stock_levels', 'Authenticated users can read warehouse_stock_levels')
  ) as t(tbl, pol)
  loop
    execute format('alter policy %I on public.%I using (true)', p.pol, p.tbl);
  end loop;
end $$;

-- 2. The feed tables.
alter policy "authenticated_read_bamida_stock" on public.bamida_material_stock using (true);
alter policy "authenticated_read_bamida_stock_history" on public.bamida_material_stock_history using (true);

-- 3. product_code_master, policy shape only (see the note at the top).
drop policy if exists "hub: read product_code_master" on public.product_code_master;
drop policy if exists "Service role full access" on public.product_code_master;
create policy "Service role full access" on public.product_code_master
  for all to public using (true) with check (true);

-- 4. Quote numbers, back to the invoker body with no capability check.
create or replace function public.get_next_quote_id()
 returns integer
 language plpgsql
as $function$
begin
  return nextval('public.quote_ref_seq');
end;
$function$;

revoke execute on function public.get_next_quote_id() from public, anon;
grant execute on function public.get_next_quote_id() to authenticated, service_role;
grant usage, select, update on sequence public.quote_ref_seq to anon, authenticated;

-- 5. The two unused functions and the PO sequence.
grant execute on function public.generate_po_number() to public;
grant execute on function public.decrement_stock(text, text, integer) to public;
grant usage, select, update on sequence public.po_number_seq to anon, authenticated;

-- 6. The Test bucket's three policies, as they were on 2026-09-16.
create policy "Give users authenticated access to folder 1jsmq_0" on storage.objects
  for select to public
  using (bucket_id = 'Test' and (storage.foldername(name))[1] = 'private' and auth.role() = 'authenticated');
create policy "Give users authenticated access to folder 1jsmq_1" on storage.objects
  for insert to public
  with check (bucket_id = 'Test' and (storage.foldername(name))[1] = 'private' and auth.role() = 'authenticated');
create policy "Give users authenticated access to folder 1jsmq_2" on storage.objects
  for update to public
  using (bucket_id = 'Test' and (storage.foldername(name))[1] = 'private' and auth.role() = 'authenticated');

-- 7. is_internal, once nothing references it any more.
drop function if exists public.is_internal();

-- 8. The profiles guard, back to the 20260914160000 body.
create or replace function public.profiles_guard_authz_columns()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(auth.role(), 'none') not in ('anon', 'authenticated') then
    return new;
  end if;
  if (new.is_super_admin is distinct from old.is_super_admin
      or new.pipeline_id is distinct from old.pipeline_id
      or new.allowed_depots is distinct from old.allowed_depots
      or new.allowed_quote_templates is distinct from old.allowed_quote_templates
      or new.allowed_distributors is distinct from old.allowed_distributors
      or new.hubspot_team_id is distinct from old.hubspot_team_id)
     and not public.is_super_admin() then
    raise exception 'profiles: authorization columns can only be changed by a super admin';
  end if;
  if new.display_name is distinct from old.display_name
     and nullif(btrim(coalesce(new.display_name, '')), '') is null
     and not public.is_super_admin() then
    raise exception 'profiles: display_name cannot be cleared';
  end if;
  return new;
end;
$function$;

-- 9. The grants FIRST, by hand. user_capabilities.capability references
--    capabilities(key) on delete cascade, so deleting the catalogue rows would
--    take every factory grant with them without saying so.
delete from public.user_capabilities where capability in ('factory.view', 'factory.update');
delete from public.capabilities where key in ('factory.view', 'factory.update');

-- 10. What the factory recorded about its orders, and the flag itself.
alter table public.po_manufacturing
  drop column if exists confirmed_at,
  drop column if exists confirmed_by_uid,
  drop column if exists confirmation_emailed_at,
  drop column if exists confirmation_was_test,
  drop column if exists dates_updated_by_uid,
  drop column if exists finished_by_uid;

alter table public.profiles drop column if exists is_external;

commit;
