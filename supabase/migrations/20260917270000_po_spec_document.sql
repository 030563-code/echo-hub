-- The manufacturing specification, as it stands on ONE order, and who signed it off.
--
-- Dean, 17 Sep 2026: "Juraj and Martin should really be able to edit all these PO's since theres
-- so many variables. It should be generated and prepopulated for him then he can edit and add
-- lines to these then it saves to the PO and prints properly. That way nothing goes unsigned."
--
-- model_spec (20260917260000) holds the STANDING specification for a model. This holds the
-- specification for one purchase order: the standing one is what the editor starts from, and
-- everything after the first save belongs to the order, not the model. An order for Japan carries
-- Japanese graphics and a hook pack; the next H10 order does not, and neither should have to
-- overwrite the other.
--
-- 🔴 WHY THE WHOLE DOCUMENT AND NOT A SET OF OVERRIDES. Whatever is stored here is what prints.
-- If this held only the differences, the printed sheet would be a join of a saved row and a live
-- model_spec that somebody could change afterwards, and the factory would be holding paper nobody
-- signed. A confirmed document has to be a thing that cannot move underneath the signature.
--
-- What is NOT stored, deliberately: the supplier and buyer blocks, the order number and the date.
-- Those are ours and are derived fresh at print time, so a saved draft can never carry a stale
-- address or somebody else's order number.
create table if not exists public.po_spec_document (
  -- One document per supplier order. Cascades because the document is worthless without the order.
  po_id uuid primary key references public.purchase_orders(id) on delete cascade,

  -- The editable half of the SupplierSpec: destination, products (with their materials,
  -- specification rows and bullets) and the packing counts. Shape is owned by
  -- src/lib/po-spec-store.ts, which validates on the way in and tolerates rows it does not
  -- recognise on the way out.
  draft jsonb not null,

  -- What the generator produced when the draft was first created, so the editor can show what was
  -- changed by hand and the order page can tell a hand-edited document from an untouched one.
  generated jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_uid uuid references auth.users(id) on delete set null,

  -- 🔴 "That way nothing goes unsigned." Null means the document is still a generated draft and
  -- the PDF says so in red on its face. Stamped means a named person read it and confirmed it,
  -- and the PDF prints their name and the date instead.
  confirmed_at timestamptz,
  confirmed_by_uid uuid references auth.users(id) on delete set null,

  constraint po_spec_document_confirmed_together
    check ((confirmed_at is null) = (confirmed_by_uid is null))
);

comment on table public.po_spec_document is
  'The -1 manufacturing specification for one purchase order: generated from the bill of materials and model_spec, then editable, then signed off. What is stored here is exactly what prints.';
comment on column public.po_spec_document.draft is
  'The editable half of the document (destination, products, materials, specification rows, bullets, packing). The supplier and buyer blocks, the order number and the date are never stored: they are derived at print time.';
comment on column public.po_spec_document.generated is
  'The generator output at the time the draft was created, kept so a hand edit can be told from an untouched document.';
comment on column public.po_spec_document.confirmed_at is
  'When somebody signed this document off. Null prints SPECIFICATION NOT YET CONFIRMED on the face of the PDF.';

create index if not exists idx_po_spec_document_confirmed
  on public.po_spec_document (confirmed_at);

-- Keep updated_at honest without every caller having to remember it.
create or replace function public.trg_po_spec_document_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists po_spec_document_touch on public.po_spec_document;
create trigger po_spec_document_touch
  before update on public.po_spec_document
  for each row
  execute function public.trg_po_spec_document_touch();

-- ---------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------
-- The same shape as po_manufacturing and po_cargo_request. Every read and write goes through a
-- server action that has already checked po.view or bom.edit and that the caller's organisation
-- holds the chain, and the factory download runs on the admin client because that account holds
-- none of the capabilities can_read_po() wants. Nothing needs a session-client path, so there is
-- no policy to get wrong.
alter table public.po_spec_document enable row level security;

drop policy if exists "Service role full access" on public.po_spec_document;
create policy "Service role full access"
  on public.po_spec_document for all to service_role
  using (true) with check (true);

revoke all on public.po_spec_document from public, anon, authenticated;
grant all on public.po_spec_document to service_role;

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'po_spec_document'
  ) then
    raise exception 'po_spec_document was not created';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'po_spec_document'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'anon or authenticated still hold grants on po_spec_document';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'po_spec_document_touch'
  ) then
    raise exception 'the updated_at trigger is missing';
  end if;
end $$;
