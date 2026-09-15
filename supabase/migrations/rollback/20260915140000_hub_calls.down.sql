-- Rollback for 20260915140000_hub_calls.sql.
--
-- The rows are NOT recoverable. The webhook that fills this table keeps no
-- history of its own (that is the whole reason the table exists), and n8n
-- retains only the last few dozen executions, so dropping it loses every call
-- the Hub has seen along with every missed-call reason and every record of who
-- linked what. Take a copy first if any of that matters:
--
--   create table hub_calls_backup as select * from public.hub_calls;
--
-- The merges themselves are not affected: those happened in HubSpot and this
-- table only records that they did.

drop function if exists public.hub_ingest_phone_call(jsonb);
drop table if exists public.hub_calls;

-- The capability row goes too, and with it any grant of it, so nobody is left
-- holding a key to a page that no longer exists.
delete from public.user_capabilities where capability = 'calls.view';
delete from public.capabilities where key = 'calls.view';
