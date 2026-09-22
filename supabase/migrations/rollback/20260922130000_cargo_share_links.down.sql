-- Undo 20260922130000_cargo_share_links.
--
-- Dropping cargo_share_link INVALIDATES EVERY LINK ALREADY SENT TO A CUSTOMER. They will get a
-- "link not found" page rather than an error, which is the right failure, but somebody outside
-- the company will notice. Say so before running this.
--
-- delay_seconds and the index rename are re-derivable: the sync recomputes delay_seconds from the
-- stored raw payload on its next run.

drop table if exists public.cargo_share_link;

alter index if exists public.idx_cargo_shipment_vessel
  rename to idx_cargo_shipment_container_search;

alter table public.cargo_event drop column if exists delay_seconds;

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'cargo_share_link') then
    raise exception 'cargo_share_link survived the rollback';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cargo_event' and column_name = 'delay_seconds'
  ) then
    raise exception 'cargo_event.delay_seconds survived the rollback';
  end if;
end $$;
