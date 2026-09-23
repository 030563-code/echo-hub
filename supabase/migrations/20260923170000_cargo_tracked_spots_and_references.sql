-- Shipments added by hand, and the references people keep on a shipment.
--
-- Dean, 23 Sep 2026: "theres no way to manually add spot ids or shipments or references?"
--
-- Until now the Hub only knew a SPOT ID if Dave's sheet had it (eb_operations.shipments, filled by
-- his n8n WF2) or a PO had resolved to it (po_shipments). A container booked any other way never
-- reached the board, and nothing on a shipment could carry our own PO or order number.
--
-- cargo_tracked_spot   a SPOT ID somebody added, checked against Cargo Partner first with the same
--                      read calls the sync makes. The sync unions it with the other two sources.
--                      Deliberately NOT po_shipments: the first SPOT ID stored for a PO books stock
--                      out of EB-SRO (trigger, 20260911120000_stock_ledger.sql).
-- cargo_shipment_reference  free references on one shipment (a PO number, a customer's reference),
--                      shown on the board and searched.

create table if not exists public.cargo_tracked_spot (
  spot_id text primary key check (spot_id ~ '^[0-9]{6,12}$'),
  -- What was typed: the SPOT ID itself, or the reference that led to it.
  added_from text not null check (length(btrim(added_from)) between 1 and 80),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now()
);

create table if not exists public.cargo_shipment_reference (
  id uuid primary key default gen_random_uuid(),
  spot_id text not null references public.cargo_shipment (spot_id) on delete cascade,
  reference text not null check (length(btrim(reference)) between 1 and 80),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  unique (spot_id, reference)
);

create index if not exists cargo_shipment_reference_spot_idx on public.cargo_shipment_reference (spot_id);

-- Same stance as the cargo tables: the Hub reads and writes them with the service role, after its
-- own capability and organisation checks. No policy for a browser key to get wrong.
alter table public.cargo_tracked_spot enable row level security;
alter table public.cargo_shipment_reference enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cargo_tracked_spot', 'cargo_shipment_reference']
  loop
    execute format('drop policy if exists "Service role full access" on public.%I', t);
    execute format(
      'create policy "Service role full access" on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cargo_tracked_spot', 'cargo_shipment_reference']
  loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t and rowsecurity) then
      raise exception 'row level security is off on %', t;
    end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated')
    ) then
      raise exception 'anon or authenticated still hold grants on %', t;
    end if;
  end loop;
end $$;
