-- The -3 priced (accounting) order, as it stands on ONE manufacturing order, and who signed it.
--
-- Dean, 22 Sep 2026, on Martin's "is it possible to change purchase order with prices?": "where
-- do they edit the priced PO?" Nowhere: the -3 was generated from the bill of materials with no
-- way to change a price, add a line or take one off. This is the mirror of po_spec_document
-- (20260917270000) for the priced order, and the same rules apply:
--
-- 🔴 THE WHOLE DOCUMENT, NOT A SET OF OVERRIDES. Whatever is stored here is what prints. A
-- confirmed document cannot move underneath the signature.
--
-- What is NOT stored, deliberately: the supplier and buyer blocks, the document number, the date
-- and the totals. The first four are derived at print time; the totals are worked out from the
-- lines every time, so a saved total can never disagree with the lines under it.
--
-- PENDING: written against the schema at 20260922090000, not applied.
create table if not exists public.po_priced_document (
  -- One document per manufacturing order. Cascades because it is worthless without the order.
  po_id uuid primary key references public.purchase_orders(id) on delete cascade,

  -- The lines: code, description, qty, unit, unit price, tax rate. Shape is owned by
  -- src/lib/po-priced-draft.ts, which validates on the way in and tolerates rows it does not
  -- recognise on the way out.
  draft jsonb not null,

  -- What the generator produced when the draft was first created, so the editor can show what was
  -- changed by hand and the order page can tell a hand-edited document from an untouched one.
  generated jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_uid uuid references auth.users(id) on delete set null,

  -- Null means nobody has signed it. Stamped means a named person read the prices and confirmed
  -- them. The printed document says neither (Dean, 22 Sep 2026: no tags on a client-facing
  -- sheet); the order page and the editor do.
  confirmed_at timestamptz,
  confirmed_by_uid uuid references auth.users(id) on delete set null,

  constraint po_priced_document_confirmed_together
    check ((confirmed_at is null) = (confirmed_by_uid is null))
);

comment on table public.po_priced_document is
  'The -3 priced order for one manufacturing order: generated from the bill of materials and the signed specification, then editable, then signed off. What is stored here is exactly what prints.';
comment on column public.po_priced_document.draft is
  'The lines (code, description, qty, unit, unit price EUR, tax rate). The supplier and buyer blocks, the document number, the date and the totals are never stored: derived at print time.';
comment on column public.po_priced_document.generated is
  'The generator output at the time the draft was created, kept so a hand edit can be told from an untouched document.';

create index if not exists idx_po_priced_document_confirmed
  on public.po_priced_document (confirmed_at);

-- Keep updated_at honest without every caller having to remember it.
create or replace function public.trg_po_priced_document_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists po_priced_document_touch on public.po_priced_document;
create trigger po_priced_document_touch
  before update on public.po_priced_document
  for each row
  execute function public.trg_po_priced_document_touch();

-- ---------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------
-- Same shape as po_spec_document. Every read and write goes through a server action that has
-- already checked po.view, cost.view and bom.edit and that the caller's organisation holds the
-- chain. Nothing needs a session-client path, so there is no policy to get wrong.
alter table public.po_priced_document enable row level security;

drop policy if exists "Service role full access" on public.po_priced_document;
create policy "Service role full access"
  on public.po_priced_document for all to service_role
  using (true) with check (true);

revoke all on public.po_priced_document from public, anon, authenticated;
grant all on public.po_priced_document to service_role;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'po_priced_document'
  ) then
    raise exception 'po_priced_document was not created';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'po_priced_document'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'anon or authenticated still hold grants on po_priced_document';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'po_priced_document_touch'
  ) then
    raise exception 'the updated_at trigger is missing';
  end if;
end $$;
