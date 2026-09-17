-- The address book behind every send, so recipients are data rather than a deploy.
--
-- Dean, 17 Sep 2026: "Maybe a tick box that already have these in for him and the ability to add
-- more to a library in supabase that adds to the tickbox", forwarding what Operations actually
-- does today:
--
--   "When i did PO for bamida i always include all of these adresses: info@bamida.sk,
--    office@bamida.sk, juraj@echobarrier.eu, lubos@bamida.sk, sklad@bamida.sk,
--    baran.miroslav@bamida.sk, marketing@bamida.sk
--    Also for cargo it depend if its sea freight transport or air transport: for air transport we
--    use contact person lucia.burdigova@cargo-partner.com ..... for sea freight
--    stefan.grofcik@cargo-partner.com, oto.tomas@cargo-partner.com and of course i include Juraj
--    in every email i send"
--
-- Two things that list makes obvious and that hard-coded constants could not express:
--   1. SEVEN people at the factory are on a purchase order, not one. The single point of contact
--      is who is ACCOUNTABLE, not who is told.
--   2. The forwarder's contact depends on the transport mode. Sea and air are different people.
--
-- 🔴 REQUIRED IS NOT THE SAME AS SELECTED. A required row is sent on every email and its tick box
-- is shown ticked and disabled, so nobody can quietly drop the manufacturer's own desk or the four
-- Dean named. A selected row starts ticked and can be unticked for one send. That distinction is
-- the whole reason this is a table and not a list of checkboxes with a default.

create table if not exists public.send_contact (
  id uuid primary key default gen_random_uuid(),

  -- Which send this contact belongs to. One book per conversation, because the factory and the
  -- forwarder have nothing to do with each other.
  channel text not null check (channel in ('manufacturing', 'cargo')),

  address text not null,
  display_name text,
  -- Who they work for, used to group the tick boxes so a reader can see at a glance that five of
  -- them are the factory's own people and four are ours.
  organisation text,

  field text not null default 'cc' check (field in ('to', 'cc')),

  -- Cargo only: the transport modes this person handles, matching cargo-request.ts MODALITIES.
  -- NULL means every mode. Sea and air are different people at the forwarder.
  modalities text[],

  -- Ticked when the screen opens.
  default_selected boolean not null default true,
  -- Ticked, disabled, and sent whatever the screen says.
  is_required boolean not null default false,

  is_active boolean not null default true,
  sort_order int not null default 100,

  created_at timestamptz not null default now(),
  created_by_uid uuid references auth.users(id) on delete set null,

  -- A required contact that is not selected by default would be a contradiction the UI could not
  -- draw: it has to be ticked, because it is always sent.
  constraint send_contact_required_is_selected check (not is_required or default_selected),
  -- Modalities only mean something on the cargo side.
  constraint send_contact_modalities_are_cargo check (modalities is null or channel = 'cargo')
);

-- One row per address per channel. The same person can be on both books with different settings.
create unique index if not exists send_contact_unique_address
  on public.send_contact (channel, lower(address));
create index if not exists send_contact_active
  on public.send_contact (channel, is_active, sort_order);

comment on table public.send_contact is
  'Address book for the Hub sends. Rendered as tick boxes on the manufacturing and cargo send screens: required rows are always sent and cannot be unticked, selected rows start ticked and can be dropped for one send.';
comment on column public.send_contact.modalities is
  'Cargo only. Transport modes this contact handles (SEA, AIR, ROAD, RAIL, SEA_AIR, AIR_SEA). NULL means every mode.';
comment on column public.send_contact.is_required is
  'Always sent, tick box shown ticked and disabled. Use for the party who is accountable, not merely informed.';

-- ---------------------------------------------------------------------------
-- What Operations actually sends today
-- ---------------------------------------------------------------------------
insert into public.send_contact
  (channel, address, display_name, organisation, field, modalities, default_selected, is_required, sort_order)
values
  -- The factory. sklad is the accountable desk (Dean, 17 Sep: "here is the absolute point of
  -- contact"); the rest are the people Operations has always copied.
  ('manufacturing', 'sklad@bamida.sk',            'Warehouse',        'Manufacturer',  'to', null, true, true,  10),
  ('manufacturing', 'info@bamida.sk',             null,               'Manufacturer',  'cc', null, true, false, 20),
  ('manufacturing', 'office@bamida.sk',           null,               'Manufacturer',  'cc', null, true, false, 21),
  ('manufacturing', 'lubos@bamida.sk',            null,               'Manufacturer',  'cc', null, true, false, 22),
  ('manufacturing', 'baran.miroslav@bamida.sk',   null,               'Manufacturer',  'cc', null, true, false, 23),
  ('manufacturing', 'marketing@bamida.sk',        null,               'Manufacturer',  'cc', null, true, false, 24),
  -- Ours. Dean, 17 Sep: these four are "automatically CCed", so they are required.
  ('manufacturing', 'juraj@echobarrier.eu',       'Juraj Ziak',       'Echo Barrier',  'cc', null, true, true,  30),
  ('manufacturing', 'andy.murphy@echobarrier.com','Andy Murphy',      'Echo Barrier',  'cc', null, true, true,  31),
  ('manufacturing', 'dave.lindsay@echobarrier.com','David Lindsay',   'Echo Barrier',  'cc', null, true, true,  32),
  ('manufacturing', 'operations@echobarrier.eu',  'Operations',       'Echo Barrier',  'cc', null, true, true,  33),

  -- The forwarder, by transport mode. The combined modes carry both people on purpose.
  ('cargo', 'lucia.burdigova@cargo-partner.com', 'Lucia Burdigova',  'Cargo Partner', 'to',
     array['AIR','SEA_AIR','AIR_SEA'], true, false, 10),
  ('cargo', 'stefan.grofcik@cargo-partner.com',  'Stefan Grofcik',   'Cargo Partner', 'to',
     array['SEA','SEA_AIR','AIR_SEA'], true, false, 11),
  ('cargo', 'oto.tomas@cargo-partner.com',       'Oto Tomas',        'Cargo Partner', 'to',
     array['SEA','SEA_AIR','AIR_SEA'], true, false, 12),
  -- "and of course i include Juraj in every email i send".
  ('cargo', 'juraj@echobarrier.eu',              'Juraj Ziak',       'Echo Barrier',  'cc', null, true, true,  30)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Readable by granted staff, because the send screens read it with the session client. Writable by
-- whoever can raise a purchase order, since adding a recipient to the book is choosing who hears
-- about our orders. An external account is not internal, so the factory cannot read our address
-- book at all.
alter table public.send_contact enable row level security;

drop policy if exists "hub: read send_contact" on public.send_contact;
create policy "hub: read send_contact"
  on public.send_contact for select to authenticated
  using ((select public.is_internal()));

drop policy if exists "hub: write send_contact" on public.send_contact;
create policy "hub: write send_contact"
  on public.send_contact for all to authenticated
  using ((select public.has_capability('po.create')))
  with check ((select public.has_capability('po.create')));

revoke all on public.send_contact from public, anon, authenticated;
grant select, insert, update on public.send_contact to authenticated;
grant all on public.send_contact to service_role;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.send_contact where channel = 'manufacturing';
  if n < 10 then raise exception 'manufacturing contacts did not seed (got %)', n; end if;

  select count(*) into n from public.send_contact where channel = 'cargo';
  if n < 4 then raise exception 'cargo contacts did not seed (got %)', n; end if;

  -- The accountable desk must be there and must be unremovable.
  if not exists (
    select 1 from public.send_contact
    where channel = 'manufacturing' and address = 'sklad@bamida.sk' and is_required and field = 'to'
  ) then
    raise exception 'the manufacturer point of contact is missing or not required';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'send_contact'
      and grantee = 'anon'
  ) then
    raise exception 'anon holds grants on send_contact';
  end if;
end $$;
