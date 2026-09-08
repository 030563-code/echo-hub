-- The manufacturing life of one Bamida order: sent, dates given, finished.
--
-- One row per SRO_TO_SUPPLIER purchase order, created when the order is emailed
-- to Bamida and updated by them afterwards. It is a separate table rather than
-- more columns on purchase_orders because Bamida write to it and they are not
-- Hub users: keeping their surface to one narrow table is what makes it
-- reviewable.
--
-- sent_at is a CLAIM, not a label. The send action sets it only where it is
-- currently null, so a double click, a retry or a refresh cannot email the same
-- purchase order to a factory twice. finished_at works the same way, because it
-- is the timestamp the Cargo Partner transport order will later hang on and so
-- may only ever happen once.

-- The decision SRO makes on the EB_GROUP_TO_SRO leg. The column already
-- existed, unused and unconstrained; this pins the two values it can take.
alter table public.purchase_orders
  drop constraint if exists purchase_orders_fulfilment_type_check;
alter table public.purchase_orders
  add constraint purchase_orders_fulfilment_type_check
  check (fulfilment_type is null or fulfilment_type in ('stock', 'manufacture'));

create table if not exists public.po_manufacturing (
  po_id                    uuid        primary key references public.purchase_orders (id) on delete cascade,

  -- Sending
  sent_at                  timestamptz,
  sent_by_uid              uuid        references auth.users (id) on delete set null,
  sent_to                  text[]      not null default '{}',
  sent_was_test            boolean     not null default false,
  -- What the Hub believed Bamida were short of at the moment it sent. Kept as
  -- written, because the shelf moves and the question later is always "what did
  -- we tell them", never "what is short now".
  short_materials          jsonb,

  -- Bamida's own answers
  est_start                date,
  est_finish               date,
  dates_updated_at         timestamptz,

  -- The one-way door
  finished_at              timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.po_manufacturing is
  'Manufacturing progress for one SRO_TO_SUPPLIER purchase order. Written by the Hub when the order is sent, and by Bamida through a signed link.';

-- Served by the app with the service-role client, never by PostgREST. RLS on
-- and every grant revoked: this project grants `authenticated` TRUNCATE on
-- every new table in public by default, and RLS does not restrain TRUNCATE.
alter table public.po_manufacturing enable row level security;
revoke all on public.po_manufacturing from public, anon, authenticated;

create or replace function public.po_manufacturing_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists po_manufacturing_touch on public.po_manufacturing;
create trigger po_manufacturing_touch
  before update on public.po_manufacturing
  for each row execute function public.po_manufacturing_touch();
