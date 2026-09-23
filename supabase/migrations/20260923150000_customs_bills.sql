-- Nippon Express customs bills: Transport, Customs tab.
--
-- Dean, 23 Sep 2026: every Nippon Express dock and customs invoice that reaches Dave's inbox
-- should pull through to the Hub, Claude reads it, a new tab under Transport only Dave sees shows
-- it prefilled the way the bill is entered in Xero, and the invoice number links to its shipment.
-- He chose: the inbox is watched on Dave's own n8n, the Hub makes the Xero bill as a DRAFT and
-- Dave's approval in the Hub authorises it, and the 31 bills already in Xero are read too.
--
-- Three things:
--   1. The capability, customs.manage, granted to Dave. Super admins see every tab by the Hub's
--      design; the grant keeps it his if that flag ever changes.
--   2. A private bucket for the scans, PDF only.
--   3. One row per PDF: where it came from, what Claude read off it, which shipment it is, and
--      where it stands in Xero. The duty checks and the prefilled bill are worked out in the Hub
--      (src/lib/customs), not stored, so a corrected rule applies to every bill at once.
--
-- Read and written by the Hub's server with the service role, after the capability check; no
-- browser ever reads the table. Additive: nothing existing changes.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is the repo record.

-- ---------------------------------------------------------------------------
-- 1. The capability
-- ---------------------------------------------------------------------------
insert into public.capabilities (key, module, description)
values ('customs.manage', 'customs',
        'See the Nippon Express customs bills under Transport and approve them into Xero')
on conflict (key) do update set module = excluded.module, description = excluded.description;

insert into public.user_capabilities (user_id, capability)
select u.id, 'customs.manage'
from auth.users u
where lower(u.email) = 'dave.lindsay@echobarrier.com'
on conflict (user_id, capability) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The scans
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customs-documents', 'customs-documents', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. The bills
-- ---------------------------------------------------------------------------
create table public.customs_bills (
  id                 uuid primary key default gen_random_uuid(),

  -- Where the PDF came from: a Nippon Express email in Dave's inbox, or a bill already in Xero.
  source             text not null check (source in ('email', 'xero_history')),
  file_sha256        text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name          text not null,
  storage_path       text not null unique,
  file_size          integer check (file_size > 0),
  gmail_message_id   text,
  email_subject      text,
  email_received_at  timestamptz,

  -- The reading. extraction is exactly what the OCR step returned, validated by
  -- customsPackageSchema; group_bills are the Group invoices it covers, as they stand in Xero.
  ocr_status         text not null default 'pending'
                       check (ocr_status in ('pending', 'requested', 'done', 'failed')),
  ocr_requested_at   timestamptz,
  ocr_at             timestamptz,
  ocr_model          text,
  ocr_error          text,
  extraction         jsonb,
  group_bills        jsonb not null default '[]'::jsonb,

  -- What the reading said, kept in columns for listing and matching.
  invoice_number     text,
  invoice_date       date,
  invoice_total      numeric(12, 2),
  entry_number       text,
  entry_date         date,
  customs_total      numeric(12, 2),
  -- A second PDF of an invoice already here (a resend) points at the first and is never billed.
  duplicate_of       uuid references public.customs_bills(id) on delete set null,

  -- The shipment in Transport, and how it was found.
  spot_id            text,
  match_method       text check (match_method in ('spot', 'container', 'mbl', 'hbl')),

  -- Xero, Echo Barrier USA LLC.
  xero_invoice_id    uuid,
  xero_status        text,
  -- The bill's lines as they stand in Xero: Dave's own coding on the bills read from history,
  -- and what was authorised on the new ones.
  xero_lines         jsonb,
  xero_synced_at     timestamptz,
  xero_error         text,
  approved_by_uid    uuid references auth.users(id) on delete set null,
  approved_at        timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One live row per Nippon invoice number; resends carry duplicate_of.
create unique index customs_bills_invoice_number_key
  on public.customs_bills (invoice_number)
  where invoice_number is not null and duplicate_of is null;
create index customs_bills_spot_id_idx on public.customs_bills (spot_id);
create index customs_bills_invoice_date_idx on public.customs_bills (invoice_date desc);
create unique index customs_bills_xero_invoice_id_key
  on public.customs_bills (xero_invoice_id)
  where xero_invoice_id is not null;

create trigger customs_bills_set_updated_at
  before update on public.customs_bills
  for each row execute function public.set_updated_at();

alter table public.customs_bills enable row level security;
revoke all on public.customs_bills from public, anon, authenticated;
grant select, insert, update, delete on public.customs_bills to service_role;

comment on table public.customs_bills is
  'Nippon Express customs invoice packages (invoice, CBP 7501, waybill), read by Claude. Service role only; the Hub checks customs.manage.';
