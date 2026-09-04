-- A remembered delivery address per customer, so a rep picks a depot they have
-- shipped to before instead of retyping it.
--
-- Keyed on contact_key, not on the Xero account code alone: open-invoice.ts
-- derives taxjar_customer_id from account_registry.usa_xero_account_code, which
-- is nullable, and hubspot_company_id is nullable too. contact_key is
-- 'xero:{code}' when there is a Xero code and 'hs:{companyId}' otherwise, so a
-- customer always resolves to exactly one book, or to none at all (in which
-- case the editor just falls back to manual entry).
--
-- location and requested_by are OPTIONAL and are NOT tax inputs. A depot label
-- like "Location G52" and the name of whoever asked for the delivery change
-- nothing about where the sale is taxed, which is why they are deliberately
-- absent from linesHash.

create table if not exists public.customer_delivery_addresses (
  id                 uuid primary key default gen_random_uuid(),
  contact_key        text not null,
  xero_account_code  text,
  hubspot_company_id text,
  company_name       text,
  street             text not null,
  city               text not null,
  state              text not null,
  zip                text not null,
  country            text not null default 'US',
  location           text,
  requested_by       text,
  created_by_uid     uuid,
  created_by_label   text,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz not null default now(),
  constraint customer_delivery_addresses_contact_key_not_blank
    check (btrim(contact_key) <> '')
);

-- The fingerprint the app writes is a lowercased, whitespace-collapsed join of
-- the address plus the location, so saving the same depot twice updates
-- last_used_at instead of adding a near-duplicate the rep then has to read past.
-- requested_by is NOT part of it: the same address requested by two different
-- people is one address, not two.
alter table public.customer_delivery_addresses
  add column if not exists fingerprint text not null default '';

create unique index if not exists customer_delivery_addresses_unique_idx
  on public.customer_delivery_addresses (contact_key, fingerprint);

create index if not exists customer_delivery_addresses_recent_idx
  on public.customer_delivery_addresses (contact_key, last_used_at desc);

alter table public.customer_delivery_addresses enable row level security;
revoke all on public.customer_delivery_addresses from public, anon, authenticated;
-- No grant and no policy, on purpose: service role only, the same doctrine
-- customer_invoices and invoice_attachments follow. Every read and write goes
-- through a server action that has already checked a capability.

comment on table public.customer_delivery_addresses is
  'Remembered ship-to addresses per customer, offered as a dropdown in the invoice editor. Service-role only.';

-- The two optional lines on the invoice itself. Nullable and with no default:
-- every existing invoice legitimately has neither.
alter table public.customer_invoices
  add column if not exists delivery_location text;

alter table public.customer_invoices
  add column if not exists delivery_requested_by text;

comment on column public.customer_invoices.delivery_location is
  'Optional depot or site label at the delivery address, e.g. "Location G52". Printed under the street on the invoice. NOT a tax input.';

comment on column public.customer_invoices.delivery_requested_by is
  'Optional name of the person who requested the delivery. Printed at the foot of the SHIP TO block. NOT a tax input.';
