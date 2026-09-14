-- Rollback for pending/20260914160000_profiles_guard_display_name.sql.
-- Run as ONE transaction (MCP execute_sql in one batch, or psql --single-transaction -f).
--
-- Restores the guard without the display_name check (the live definition read
-- on 2026-09-14) and the PUBLIC and anon EXECUTE grants on get_next_quote_id.
-- Rolling back reopens both gaps described in the up file.

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
$function$;

grant execute on function public.get_next_quote_id() to public;
grant execute on function public.get_next_quote_id() to anon;
