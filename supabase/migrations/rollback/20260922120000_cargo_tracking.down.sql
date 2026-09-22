-- Undo 20260922120000_cargo_tracking.
--
-- Safe to run: these four tables are the Hub's own copy of what Cargo Partner already holds, and
-- the sync rebuilds every row from the API. Nothing here is a system of record, so dropping them
-- loses nothing that a re-sync does not put back.
--
-- eb_operations.shipments is NOT touched. That table is Dave's n8n WF2's and three depot emails
-- to external forwarders read it. It was never part of this migration and must not be part of
-- undoing it.

drop trigger if exists cargo_shipment_touch on public.cargo_shipment;
drop function if exists public.trg_cargo_shipment_touch();

-- Children first: each carries an on delete cascade to cargo_shipment, but dropping in order
-- means this file also works if somebody has already dropped the parent by hand.
drop table if exists public.cargo_event;
drop table if exists public.cargo_routing_point;
drop table if exists public.cargo_container;
drop table if exists public.cargo_shipment;

do $$
declare t text;
begin
  foreach t in array array['cargo_shipment', 'cargo_container', 'cargo_routing_point', 'cargo_event']
  loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      raise exception '% survived the rollback', t;
    end if;
  end loop;
end $$;
