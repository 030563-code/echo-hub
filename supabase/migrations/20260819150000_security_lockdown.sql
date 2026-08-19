-- Post-audit security lockdown (2026-08-19 quotes re-audit).
-- ALREADY APPLIED LIVE via MCP apply_migration (quotes_audit_security_lockdown)
-- on korylyniwsqtsvzuzydg — this file is the repo mirror. Never `db push`.
-- Every object tightened here has ZERO authenticated-role usage in the Hub app
-- (verified by code grep); they are written by n8n on service_role, which
-- bypasses RLS and keeps its grants.

-- 1) apply_manufacturing_stocktake was executable by anon/PUBLIC with no
--    identity check in the body: the public anon key plus a leaked stocktake
--    UUID was enough to overwrite live warehouse_stock_levels.
revoke execute on function public.apply_manufacturing_stocktake(uuid) from public, anon, authenticated;
comment on function public.apply_manufacturing_stocktake(uuid) is
  'Applies a manufacturing stocktake to warehouse_stock_levels. EXECUTE is service_role-only by design (n8n); do not re-grant to anon/authenticated — the body performs no identity check.';

-- 2) invoices_registry was readable by every authenticated user regardless of
--    capability or region; gate on invoice.view to match commercial_invoices.
drop policy "Authenticated users can read invoices_registry" on public.invoices_registry;
create policy "hub: read invoices_registry with invoice.view"
  on public.invoices_registry for select to authenticated
  using ((select public.has_capability('invoice.view')));

-- 3) shipments / shipment_contents / shipment_events had unconditional
--    authenticated WRITE policies serving no app code path (all writes come
--    from n8n on service_role). Read policies are left as they were.
drop policy "Authenticated users can update shipments" on public.shipments;
drop policy "Authenticated users can insert shipment_contents" on public.shipment_contents;
drop policy "Authenticated users can update shipment_contents" on public.shipment_contents;
drop policy "Authenticated users can insert shipment_events" on public.shipment_events;

-- 4) onix_sku_mapping had an unconditional authenticated UPDATE policy; the
--    app never writes this table.
drop policy "Authenticated users can update onix_sku_mapping" on public.onix_sku_mapping;

-- 5) deal_stage_history was readable by any authenticated user with no gate;
--    scope to the quotes capability + the caller's own region (same pipeline
--    model as deals_registry), super admins unrestricted.
drop policy "hub: read deal_stage_history" on public.deal_stage_history;
create policy "hub: read deal_stage_history in region"
  on public.deal_stage_history for select to authenticated
  using (
    (select public.is_super_admin())
    or (
      (select public.has_capability('quotes.view'))
      and exists (
        select 1
        from public.deals_registry dr
        where dr.hubspot_deal_id = deal_stage_history.deal_id
          and dr.pipeline_id is not null
          and dr.pipeline_id::text = (select p.pipeline_id::text from public.profiles p where p.id = auth.uid())
      )
    )
  );

-- 6) profiles: self-escalation is currently blocked ONLY by column-level
--    grants (authenticated may UPDATE display_name alone). One careless broad
--    GRANT would silently reopen is_super_admin / allowed_depots / pipeline_id
--    to self-service. This trigger makes the restriction survive grant drift.
create or replace function public.profiles_guard_authz_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- service_role / direct connections carry no anon|authenticated JWT role.
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
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_authz on public.profiles;
create trigger trg_profiles_guard_authz
  before update on public.profiles
  for each row execute function public.profiles_guard_authz_columns();

-- 7) Pin search_path on the two remaining SECURITY DEFINER functions without
--    one (their net.http_post calls are schema-qualified, so this is safe).
alter function public.notify_po_phase1() set search_path = public, pg_temp;
alter function public.notify_po_phase2() set search_path = public, pg_temp;
