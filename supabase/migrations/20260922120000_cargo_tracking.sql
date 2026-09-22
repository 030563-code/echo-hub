-- Cargo Partner shipments as the Hub holds them: the container, the route it takes and every
-- milestone the forwarder raises against it.
--
-- Dean, 22 Sep 2026: "Create a visual representation of cargo currently in transit, showing its
-- status, which can be shared internally with the team and, where appropriate, with clients ...
-- we have a lot of good data that we need to load with spot ids and shipments and containers
-- which would be useful to ALL load onto the Hub and to use in future for our prediction model
-- when it comes to lead times etc."
--
-- WHAT WAS THERE BEFORE. Three half-tables and one that works.
--   public.shipments          5 rows, last written 6 Feb 2026, whole payloads in a jsonb column
--   public.shipment_events    0 rows, never written to by anything
--   public.shipment_contents  11 rows, hand-loaded, and the ONLY thing /transport reads
--   eb_operations.shipments   39 rows, rewritten every morning by Dave's n8n WF2
-- So the screen showed eleven hand-typed rows while the live position of every container sat in
-- a table the Hub never opened. These four tables are the Hub's own copy, synced from the API,
-- and eb_operations.shipments is left exactly as it is: Dave's workflow owns it, three depot
-- emails to external forwarders depend on it, and two writers on one table is how they disagree.
--
-- 🔴 THE ROUTE IS NOT A TEMPLATE. Of the 25 real shipments read on 22 Sep 2026, the route runs
-- from 2 to 6 points: one is a single sea leg, another goes Presov, Zlin, Bremerhaven, Norfolk,
-- Harrisburg, Jessup. Routing points are therefore rows, not columns, and the screen draws what
-- the API returned. A fixed pickup/load/discharge/deliver schema would have been wrong on the
-- first shipment that transhipped.
--
-- 🔴 EVENTS ARE THE POINT, NOT A LOG. The lead-time model Dean wants is measured between the
-- stamps in cargo_event, and cargo_event.delay_days is the only figure in the whole payload that
-- measures lateness directly: Cargo Partner raises an exception carrying "ETA Port of Discharge
-- Changed: 7 day(s)" whenever a schedule moves. Those are kept signed, so a sailing pulled
-- forward reads -2 rather than being lost.

-- ---------------------------------------------------------------------------
-- The shipment
-- ---------------------------------------------------------------------------
create table if not exists public.cargo_shipment (
  -- Cargo Partner's SPOT ID, which is the identifier every other system quotes.
  spot_id text primary key,

  -- What kind of journey. SEA / FCL on everything seen so far, but stored rather than assumed.
  modality text,
  category text,

  -- The sea leg, for the people who ring the carrier.
  vessel_name text,
  voyage_number text,
  ocean_carrier text,
  hbl text,
  mbl text,

  -- The parties as the forwarder has them, which is not always how we spell them.
  shipper_name text,
  consignee_name text,

  -- The two ends of the journey.
  origin_city text,
  origin_country text,
  destination_city text,
  destination_country text,
  -- Our depot code (US-BAL, US-SBD, CA-HAM ...) where we can work it out. Null is honest: some
  -- shipments deliver somewhere that is not one of our depots.
  destination_depot text,

  -- What is inside.
  total_pieces integer,
  total_weight numeric,
  total_volume numeric,
  goods_value numeric,
  currency_code text,
  cargo_description text,

  -- The customer's own order number, which is what a person searches by.
  general_reference text,
  -- Every reference the forwarder holds, including the general one. [{type, number}].
  references_json jsonb not null default '[]'::jsonb,

  -- The milestones, lifted out of the events so a lead time is one query and not a fold.
  -- Each is the FIRST time that milestone was raised: a two-container shipment raises "loaded on
  -- vessel" twice and the leg began at the earlier of them.
  cargo_ready_on date,
  picked_up_on date,
  loaded_on_vessel_on date,
  departed_on date,
  unloaded_on date,
  arrived_on date,
  delivered_on date,
  empty_returned_on date,

  -- The date to promise somebody: the delivery estimate, else arrival at the port of discharge.
  -- Never an intermediate transhipment, which would read as an arrival that is not one.
  eta date,

  -- Where it is now. Derived from the events that have ACTUALLY happened, never from an estimate
  -- dated in the future. See src/lib/cargo/payload.ts for why that distinction is load bearing.
  current_status text,
  current_status_on date,
  current_status_location text,

  -- True once the goods are delivered or the empty container has gone back. Cargo Partner raises
  -- a delivered event on roughly one shipment in twenty-five, so a returned empty counts: the
  -- container cannot go back to the carrier with the goods still in it.
  is_complete boolean not null default false,

  -- The response as it arrived, so a field we have not thought to parse yet is not lost and a
  -- re-parse never needs another 25 calls against the forwarder.
  raw jsonb not null,

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.cargo_shipment is
  'One Cargo Partner shipment (SPOT ID): the container, the vessel, the cargo, the derived milestones and where it is now. Synced read-only from the forwarder; the Hub never writes back to them.';
comment on column public.cargo_shipment.current_status is
  'The latest milestone that has actually happened. Never an estimate: the payload carries future-dated estimates that would otherwise be reported as the current position.';
comment on column public.cargo_shipment.is_complete is
  'Delivered, or the empty container returned. A delivered event is rare in this API, a returned empty is not.';
comment on column public.cargo_shipment.raw is
  'The whole /shipments/{id} response, so nothing is lost to a parser that did not know about it yet.';

create index if not exists idx_cargo_shipment_open on public.cargo_shipment (is_complete, eta);
create index if not exists idx_cargo_shipment_depot on public.cargo_shipment (destination_depot);
create index if not exists idx_cargo_shipment_reference on public.cargo_shipment (general_reference);
create index if not exists idx_cargo_shipment_container_search on public.cargo_shipment (vessel_name);

-- ---------------------------------------------------------------------------
-- The containers
-- ---------------------------------------------------------------------------
-- A shipment can carry more than one, and the events say which container they belong to, so this
-- cannot be a column on the shipment.
create table if not exists public.cargo_container (
  spot_id text not null references public.cargo_shipment(spot_id) on delete cascade,
  container_index integer not null,
  container_number text not null,
  container_code text,
  seal_number text,
  primary key (spot_id, container_index)
);

comment on table public.cargo_container is
  'The containers on one shipment. Plural on purpose: events are raised per container.';

create index if not exists idx_cargo_container_number on public.cargo_container (container_number);

-- ---------------------------------------------------------------------------
-- The route
-- ---------------------------------------------------------------------------
create table if not exists public.cargo_routing_point (
  spot_id text not null references public.cargo_shipment(spot_id) on delete cascade,
  -- Position along the journey, 0 first. The API returns them in route order and we keep it.
  seq integer not null,
  -- PICKUP | PORT_OF_LOADING | TRANSIT_HUB | PORT_OF_DISCHARGE | DELIVERY, and whatever else
  -- they add. Not an enum: a type we have not seen must land in the table, not bounce.
  point_type text not null,
  unlocode text,
  country_code text,
  city text,
  -- SEA_FCL | RAIL_FCL | ROAD_FTL: how the cargo leaves this point for the next one.
  leg_modality text,
  estimated_departure date,
  real_departure date,
  estimated_arrival date,
  real_arrival date,
  primary key (spot_id, seq)
);

comment on table public.cargo_routing_point is
  'The stops on one shipment in route order. Rows, not columns: a real route ran from two stops to six across 25 shipments.';
comment on column public.cargo_routing_point.real_arrival is
  'Set only once it has actually happened. An estimated date with no real one beside it is still in the future.';

-- ---------------------------------------------------------------------------
-- The events
-- ---------------------------------------------------------------------------
create table if not exists public.cargo_event (
  id uuid primary key default gen_random_uuid(),
  spot_id text not null references public.cargo_shipment(spot_id) on delete cascade,

  -- Cargo Partner's numeric event identifier. Keyed on rather than the name, because a name is a
  -- label and a label can be reworded without warning. Text, since the API sends it as one.
  event_identifier text not null,
  event_name text not null,
  -- 'actual' something happened | 'estimate' something is forecast | 'exception' a schedule moved.
  event_kind text not null check (event_kind in ('actual', 'estimate', 'exception')),

  event_on date not null,
  -- '' when the forwarder gave a date and no time. Kept so ordering within a day stays stable.
  event_time text not null default '',

  location_code text,
  location_name text,
  -- Which container this milestone belongs to, where the API says. Null on a shipment-wide one.
  container_number text,

  remark text,
  -- Signed days a schedule moved, parsed out of the remark ("...Changed: 7 day(s)" and
  -- "...Changed: -2 day(s)"). 🔴 The only direct measure of lateness in the whole payload, and
  -- the input the lead-time model will want. Null means the remark did not name a slip, which is
  -- not the same as a slip of zero.
  delay_days integer
);

comment on table public.cargo_event is
  'Every milestone Cargo Partner raises against a shipment. The lead-time record: durations are measured between these, and delay_days carries the schedule slips.';
comment on column public.cargo_event.event_kind is
  'An estimate is dated in the future. Reporting one as the current position is the bug this column exists to make impossible.';

create index if not exists idx_cargo_event_spot on public.cargo_event (spot_id, event_on, event_time);
create index if not exists idx_cargo_event_type on public.cargo_event (event_identifier, event_on);
create index if not exists idx_cargo_event_delays on public.cargo_event (delay_days) where delay_days is not null;

-- ---------------------------------------------------------------------------
-- Keep updated_at honest
-- ---------------------------------------------------------------------------
create or replace function public.trg_cargo_shipment_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cargo_shipment_touch on public.cargo_shipment;
create trigger cargo_shipment_touch
  before update on public.cargo_shipment
  for each row
  execute function public.trg_cargo_shipment_touch();

-- ---------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------
-- Same shape as po_priced_document. Every read goes through a server component or action that has
-- already checked the capability and the caller's organisation, so there is no session-client path
-- and no policy to get wrong. The sync writes with the service role.
alter table public.cargo_shipment enable row level security;
alter table public.cargo_container enable row level security;
alter table public.cargo_routing_point enable row level security;
alter table public.cargo_event enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cargo_shipment', 'cargo_container', 'cargo_routing_point', 'cargo_event']
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
  foreach t in array array['cargo_shipment', 'cargo_container', 'cargo_routing_point', 'cargo_event']
  loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      raise exception '% was not created', t;
    end if;

    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t and rowsecurity
    ) then
      raise exception 'row level security is off on %', t;
    end if;

    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated')
    ) then
      raise exception 'anon or authenticated still hold grants on %', t;
    end if;
  end loop;

  if not exists (select 1 from pg_trigger where tgname = 'cargo_shipment_touch') then
    raise exception 'the updated_at trigger is missing';
  end if;
end $$;
