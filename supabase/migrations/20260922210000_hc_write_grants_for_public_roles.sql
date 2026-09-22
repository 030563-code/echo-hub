-- House Clearing: a read-only view of which tables the browser-facing roles may write to.
-- information_schema is not reachable through PostgREST, so the credentials checker calls this.
-- STABLE so PostgREST accepts it over GET. Only service_role may execute it.
-- Applied live to korylyniwsqtsvzuzydg via the Supabase MCP on 2026-09-22.
create or replace function public.hc_write_grants_for_public_roles()
returns table(table_schema text, table_name text, grantee text, privileges text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select g.table_schema::text, g.table_name::text, g.grantee::text,
         string_agg(g.privilege_type::text, ',' order by g.privilege_type) as privileges
  from information_schema.role_table_grants g
  where g.grantee in ('anon', 'authenticated')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and g.table_schema in ('public', 'eb_operations')
  group by 1, 2, 3
$$;
revoke all on function public.hc_write_grants_for_public_roles() from public;
revoke all on function public.hc_write_grants_for_public_roles() from anon;
revoke all on function public.hc_write_grants_for_public_roles() from authenticated;
grant execute on function public.hc_write_grants_for_public_roles() to service_role;
comment on function public.hc_write_grants_for_public_roles() is 'House Clearing credentials checker. Read-only. service_role only.';
