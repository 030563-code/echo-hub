-- Three corrections to 20260922120000_cargo_tracking, and the door a customer comes through.
--
-- Dean, 22 Sep 2026: a cargo view "which can be shared internally with the team and, where
-- appropriate, with clients."
--
-- 🔴 THERE IS NO CUSTOMER KEY ANYWHERE. Not on cargo_shipment, not on shipment_contents, not on
-- po_shipments, not on eb_operations.shipments. The only thread back to an order is
-- general_reference, which is free text, is present on 9 of 25 shipments, and holds two order
-- numbers in one comma-separated string when a container carries two. So "show a customer their
-- shipments" cannot be answered from the data, and pretending otherwise would mean showing
-- somebody a container that is not theirs.
--
-- What CAN be answered is "show this person this one shipment". A link is minted for one
-- shipment by somebody who already has transport.view, it can be revoked, it can expire, and it
-- carries no prices. That is a smaller promise than a customer login and it is one the data
-- actually supports.

-- ---------------------------------------------------------------------------
-- 1. The precise slip
-- ---------------------------------------------------------------------------
-- The remark truncates. Cargo Partner sends "ETD Port of Loading Changed: 7 day(s)" beside an
-- attribute reading 676800 seconds, which is 7.8 days. A model fed the wording would be told a
-- week-long slip was a day shorter than it was, every time.
alter table public.cargo_event add column if not exists delay_seconds integer;

comment on column public.cargo_event.delay_seconds is
  'The schedule slip in seconds, exact. delay_days beside it is the forwarder''s own wording, which rounds down: 676800 seconds is printed as "7 day(s)".';

-- ---------------------------------------------------------------------------
-- 2. An index that lied about itself
-- ---------------------------------------------------------------------------
-- idx_cargo_shipment_container_search was on vessel_name. Container numbers live in
-- cargo_container and already have idx_cargo_container_number.
alter index if exists public.idx_cargo_shipment_container_search
  rename to idx_cargo_shipment_vessel;

-- ---------------------------------------------------------------------------
-- 3. The share link
-- ---------------------------------------------------------------------------
create table if not exists public.cargo_share_link (
  -- The secret in the URL. Long and random, minted in the action, never derived from the SPOT ID:
  -- a guessable token is not a token.
  token text primary key,

  spot_id text not null references public.cargo_shipment(spot_id) on delete cascade,

  -- Who it was made for, in our words, so a revoke list is readable by a person. Shown to nobody
  -- outside the company.
  label text,

  created_at timestamptz not null default now(),
  created_by_uid uuid references auth.users(id) on delete set null,

  -- Both nullable. Null expires_at is a link that runs until somebody revokes it, which is what
  -- you want for a container that keeps slipping.
  expires_at timestamptz,
  revoked_at timestamptz,

  -- Enough to answer "did they ever open it" without tracking a person.
  last_viewed_at timestamptz,
  view_count integer not null default 0,

  constraint cargo_share_link_token_long_enough check (length(token) >= 32)
);

comment on table public.cargo_share_link is
  'One revocable, optionally expiring link to ONE shipment, for a customer who has no Hub login. There is no customer key in any shipment table, so a link is per shipment and per recipient rather than a customer account.';
comment on column public.cargo_share_link.label is
  'Internal note on who the link was for. Never rendered on the shared page.';

create index if not exists idx_cargo_share_link_spot on public.cargo_share_link (spot_id);
create index if not exists idx_cargo_share_link_live
  on public.cargo_share_link (spot_id) where revoked_at is null;

-- Service role only, like the tables it points at. The public tracking page runs on the server,
-- checks the token, and reads with the admin client; there is no session and therefore no policy
-- that could be written to let a browser read this table directly.
alter table public.cargo_share_link enable row level security;

drop policy if exists "Service role full access" on public.cargo_share_link;
create policy "Service role full access"
  on public.cargo_share_link for all to service_role
  using (true) with check (true);

revoke all on public.cargo_share_link from public, anon, authenticated;
grant all on public.cargo_share_link to service_role;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cargo_event' and column_name = 'delay_seconds'
  ) then
    raise exception 'cargo_event.delay_seconds is missing';
  end if;

  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_cargo_shipment_container_search') then
    raise exception 'the misnamed index is still there';
  end if;

  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'cargo_share_link') then
    raise exception 'cargo_share_link was not created';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cargo_share_link' and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'anon or authenticated hold grants on cargo_share_link';
  end if;

  -- A short token must be refused. Asserted from the catalogue rather than by
  -- attempting an insert: with no shipment to point at, the foreign key could
  -- fire first and the check would go untested while the block still passed.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cargo_share_link'::regclass
      and conname = 'cargo_share_link_token_long_enough'
      and contype = 'c'
  ) then
    raise exception 'the token length check is missing';
  end if;
end $$;
