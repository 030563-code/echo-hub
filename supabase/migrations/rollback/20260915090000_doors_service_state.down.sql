-- Reverses 20260915090000_doors_service_state.sql.
--
-- Drops the whole schema, so it also drops the audit log. Export it first if a
-- run is under investigation:
--   copy (select * from doors.access_log) to stdout with csv header;
--
-- The role is dropped last and only if nothing else depends on it. If Railway is
-- still pointed at this database the service will fail its next connection,
-- which is the intended signal: stop the service before running this.

drop function if exists doors.purge_access_log(integer);
drop function if exists doors.hub_deal_status(text);
drop function if exists doors.resolve_viewer(text);
drop function if exists doors.authenticate(text, bytea);

drop table if exists doors.access_log;
drop table if exists doors.viewers;
drop table if exists doors.agents;

drop schema if exists doors cascade;

revoke all on schema public from doors_api;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'doors_api') then
    drop owned by doors_api;
    drop role doors_api;
  end if;
end
$$;
