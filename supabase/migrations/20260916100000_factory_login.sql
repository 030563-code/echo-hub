-- The factory gets a Hub login, so "signed in" stops meaning "one of us".
--
-- Dean, 16 Sep 2026: "I personally think its very safe to also have them in the
-- hub login with their own credentials." It can be, but not as the database
-- stands. A Hub login is a Supabase session, and with the anon key out of the
-- browser bundle a session can call PostgREST directly, where RLS is the only
-- thing that answers. Read live on 16 Sep, before this file existed:
--
--   * 32 tables answered `using (true)` to any signed-in user: every depot's
--     stock, the customer account register, shipments, the MRP tables including
--     deal demand, the picklists.
--   * product_code_master, the Xero item-code master n8n builds PO lines from,
--     had one policy, `for all to public using (true)`, and both anon and
--     authenticated held INSERT, UPDATE, DELETE and TRUNCATE on it.
--   * get_next_quote_id() was callable by any signed-in user, and both number
--     sequences granted rwU to anon and authenticated.
--   * Storage bucket "Test" let any signed-in user read, upload and overwrite.
--
-- So this is not "add a flag". It is: decide what internal means, and confine
-- everything that was open to it.
--
-- internal = a profile that is not external AND is a super admin or holds at
-- least one capability row. Fail closed on purpose: self-signup is on at the
-- Auth provider today (Dean turns it off), so "has a profiles row" is not a
-- claim about anybody. A staff member becomes internal when Dean grants their
-- first capability, which is already the onboarding step.
--
-- APPLIED via MCP apply_migration on korylyniwsqtsvzuzydg. This file is the
-- repo record of what ran. Never db push.

begin;

-- ---------------------------------------------------------------------------
-- 1. The account flag.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_external boolean not null default false;

comment on column public.profiles.is_external is
  'An account belonging to an outside company (the manufacturer). Every read policy that used to answer `true` to any signed-in user is confined to internal accounts through public.is_internal().';

-- ---------------------------------------------------------------------------
-- 2. is_external joins the authorization columns, and an external account
--    cannot rename itself into somebody else.
--
--    authenticated holds column UPDATE on profiles for bio, display_name and
--    job_title only, so is_external is already unwritable from a session. This
--    is the second lock, and it is the one that survives a future grant.
--
--    Body below is the live definition read on 2026-09-16 with two clauses
--    added. create or replace keeps the trigger and the grants.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard_authz_columns()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- service_role / direct connections carry no anon|authenticated JWT role.
  if coalesce(auth.role(), 'none') not in ('anon', 'authenticated') then
    return new;
  end if;
  if (new.is_super_admin is distinct from old.is_super_admin
      or new.is_external is distinct from old.is_external
      or new.pipeline_id is distinct from old.pipeline_id
      or new.allowed_depots is distinct from old.allowed_depots
      or new.allowed_quote_templates is distinct from old.allowed_quote_templates
      or new.allowed_distributors is distinct from old.allowed_distributors
      or new.hubspot_team_id is distinct from old.hubspot_team_id)
     and not public.is_super_admin() then
    raise exception 'profiles: authorization columns can only be changed by a super admin';
  end if;
  -- A blank name is what reopens onboarding, which rewrites the authorization
  -- columns through the admin client. So clearing it is an authorization change.
  if new.display_name is distinct from old.display_name
     and nullif(btrim(coalesce(new.display_name, '')), '') is null
     and not public.is_super_admin() then
    raise exception 'profiles: display_name cannot be cleared';
  end if;
  -- An outside company does not get to appear as one of our people.
  if coalesce(old.is_external, false)
     and new.display_name is distinct from old.display_name
     and not public.is_super_admin() then
    raise exception 'profiles: an external account cannot change its display name';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. What internal means. Same shape as is_super_admin(): SECURITY DEFINER so
--    it can read profiles regardless of the caller, STABLE so the planner may
--    hoist it, search_path pinned.
-- ---------------------------------------------------------------------------
create or replace function public.is_internal()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and not p.is_external
      and (p.is_super_admin
           or exists (select 1 from public.user_capabilities uc where uc.user_id = p.id))
  );
$function$;

comment on function public.is_internal() is
  'True for a staff account: a profile that is not external and either is a super admin or holds at least one capability. Fails closed, so a self-registered account with no grants reads nothing.';

revoke execute on function public.is_internal() from public, anon;
grant execute on function public.is_internal() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The thirty tables that answered `true` to anybody signed in.
--
--    alter policy rather than drop and create: it keeps the name and the role,
--    and it RAISES on a name that does not exist, so a policy renamed since
--    this was written fails the migration instead of being silently skipped.
--    The pairs below were read from pg_policies on 2026-09-16.
-- ---------------------------------------------------------------------------
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
    execute format(
      'alter policy %I on public.%I using ((select public.is_internal()))',
      p.pol, p.tbl
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The factory's own material feed is the one thing they may read. It is
--    their stock, reported by their own system; we are handing it back.
-- ---------------------------------------------------------------------------
alter policy "authenticated_read_bamida_stock" on public.bamida_material_stock
  using ((select public.is_internal()) or (select public.has_capability('factory.view')));

alter policy "authenticated_read_bamida_stock_history" on public.bamida_material_stock_history
  using ((select public.is_internal()) or (select public.has_capability('factory.view')));

-- ---------------------------------------------------------------------------
-- 6. product_code_master. Its policy said `for all to public using (true)`
--    while every sibling table checks the service_role JWT, and anon held the
--    write grants as well. The Hub reads this table with the caller's own
--    client on the raise-a-PO form, so the read stays, confined.
-- ---------------------------------------------------------------------------
drop policy if exists "Service role full access" on public.product_code_master;

create policy "Service role full access" on public.product_code_master
  for all to service_role using (true) with check (true);

create policy "hub: read product_code_master" on public.product_code_master
  for select to authenticated using ((select public.is_internal()));

revoke all on public.product_code_master from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on public.product_code_master from authenticated;
grant select on public.product_code_master to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Quote numbers are customer-visible and monotonic. Burning them is cheap
--    and permanent, so the number comes with a capability now. service_role
--    (n8n) is untouched: the guard only looks at anon and authenticated.
-- ---------------------------------------------------------------------------
create or replace function public.get_next_quote_id()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(auth.role(), 'none') in ('anon', 'authenticated')
     and not public.has_capability('quotes.create') then
    raise exception 'forbidden: requires quotes.create';
  end if;
  return nextval('public.quote_ref_seq');
end;
$function$;

revoke execute on function public.get_next_quote_id() from public, anon;
grant execute on function public.get_next_quote_id() to authenticated, service_role;
revoke all on sequence public.quote_ref_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Two functions nothing in the Hub calls from a session.
--    generate_po_number is reached only from hub_mint_po_number, which is
--    SECURITY DEFINER and owned by postgres, so minting a PO number still
--    works. decrement_stock has no caller at all and would write stock
--    levels directly if it ever got a grant.
-- ---------------------------------------------------------------------------
revoke execute on function public.generate_po_number() from public, anon, authenticated;
revoke execute on function public.decrement_stock(text, text, integer) from public, anon, authenticated;
revoke all on sequence public.po_number_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Storage. The "Test" bucket carried three policies letting any signed-in
--    user read, upload and overwrite under private/. The bucket and its two
--    objects are left alone; only the open door closes.
-- ---------------------------------------------------------------------------
drop policy if exists "Give users authenticated access to folder 1jsmq_0" on storage.objects;
drop policy if exists "Give users authenticated access to folder 1jsmq_1" on storage.objects;
drop policy if exists "Give users authenticated access to folder 1jsmq_2" on storage.objects;

-- ---------------------------------------------------------------------------
-- 10. Verbs a browser session can never legitimately use. RLS does not
--     restrain TRUNCATE, and this project grants it on every new table in
--     public by default.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- pg_tables lists no views, and view_sku_demand had the write verbs too. It is
-- a security_invoker view over deals_registry, so a write through it was always
-- RLS-bound, but the grant had no reason to exist.
revoke truncate, references, trigger, insert, update, delete
  on public.view_sku_demand from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. What the factory account may do, and the three things we record about
--     an order once they can act on it themselves.
-- ---------------------------------------------------------------------------
insert into public.capabilities (key, module, description) values
  ('factory.view',   'factory', 'Open the Factory tabs: the purchase orders sent to the manufacturer, and their own material stock feed'),
  ('factory.update', 'factory', 'From the Factory tab, confirm a sent order with estimated dates and press Manufacturing finished')
on conflict (key) do update
  set module = excluded.module, description = excluded.description;

alter table public.po_manufacturing
  add column if not exists confirmed_at            timestamptz,
  add column if not exists confirmed_by_uid        uuid references auth.users (id) on delete set null,
  add column if not exists confirmation_emailed_at timestamptz,
  add column if not exists confirmation_was_test   boolean,
  add column if not exists dates_updated_by_uid    uuid references auth.users (id) on delete set null,
  add column if not exists finished_by_uid         uuid references auth.users (id) on delete set null;

comment on column public.po_manufacturing.confirmed_at is
  'When the manufacturer accepted the order. Set once, and only with both estimated dates, because the confirmation email quotes them back.';
comment on column public.po_manufacturing.finished_by_uid is
  'The Hub account that pressed Manufacturing finished.';

-- ---------------------------------------------------------------------------
-- 12. The check that makes this file worth trusting. If any read policy still
--     answers `true` to a signed-in role, or anon or authenticated can still
--     write the Xero item-code master, nothing above commits.
-- ---------------------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(tablename || '.' || policyname, ', ' order by tablename)
    into bad
  from pg_policies
  where schemaname = 'public'
    and qual = 'true'
    and cmd in ('SELECT', 'ALL')
    and roles::text[] && array['public', 'anon', 'authenticated'];
  if bad is not null then
    raise exception 'factory_login: read-all policies remain for signed-in roles: %', bad;
  end if;

  if has_table_privilege('authenticated', 'public.product_code_master', 'UPDATE')
     or has_table_privilege('anon', 'public.product_code_master', 'UPDATE')
     or has_table_privilege('anon', 'public.product_code_master', 'SELECT') then
    raise exception 'factory_login: product_code_master is still writable from a browser';
  end if;
end $$;

commit;
