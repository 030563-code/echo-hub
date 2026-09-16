-- APPLIED 2026-09-14 via MCP apply_migration on korylyniwsqtsvzuzydg. This file
-- is the repo record of what ran. Never db push.
--
-- Two pre-existing gaps, closed for every user (found while building Jack's
-- agent quote route).
--
-- 1. The onboarding re-scope. completeOnboarding (complete-onboarding.ts) treats
--    a profile with no display_name as not yet onboarded, and then writes
--    pipeline_id, allowed_depots and allowed_quote_templates for any region
--    through the ADMIN client. authenticated holds column UPDATE on
--    display_name, and trg_profiles_guard_authz never looked at it, so any
--    signed-in user could null their own name, reopen onboarding and pick a new
--    region. The guard now refuses a change of display_name to null or blank by
--    anyone who is not a super admin. Unchanged:
--      - service_role writes (onboarding itself, admin screens) return early;
--      - a rep renaming themselves to a real name still works;
--      - setting a first name on a profile whose name is still blank works,
--        because the NEW value is not blank.
--    Checked live 2026-09-14 before writing: 1 of 11 profiles has a blank
--    display_name today; the guard fires only on a change, so that row is not
--    affected until someone edits it.
--
-- 2. get_next_quote_id was executable by anon. Its ACL was
--    {=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres},
--    so the PUBLIC grant alone kept anon in: revoking from anon without revoking
--    from PUBLIC would change nothing. Anyone holding the public anon key could
--    burn quote numbers. createQuote calls it through the signed-in session
--    client (authenticated), which keeps its grant. Only that caller exists in
--    this repo; n8n workflows were NOT searched for an anon caller, so check
--    before applying.
--
-- The function body below is the live definition read on 2026-09-14 with the
-- display_name check added. create or replace keeps the existing grants.

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
  -- A blank name is what reopens onboarding, which rewrites the authorization
  -- columns through the admin client. So clearing it is an authorization change.
  if new.display_name is distinct from old.display_name
     and nullif(btrim(coalesce(new.display_name, '')), '') is null
     and not public.is_super_admin() then
    raise exception 'profiles: display_name cannot be cleared';
  end if;
  return new;
end;
$function$;

revoke execute on function public.get_next_quote_id() from public;
revoke execute on function public.get_next_quote_id() from anon;
grant execute on function public.get_next_quote_id() to authenticated;
grant execute on function public.get_next_quote_id() to service_role;
