-- The bill-to block, snapshotted onto the invoice.
--
-- Dean, 2026-09-03: the invoice "should have the delivery address and the
-- customer details that we put in from Xero and former tax calc step".
--
-- Snapshot rather than a live read, deliberately, and this reverses the note in
-- xero-contact.ts about reading Xero live rather than copying into our schema.
-- That reasoning holds for a card on a screen, where fresh beats stale. It is
-- wrong for an issued financial document: re-reading Xero at print time means
-- an address edited next month silently rewrites the address printed on an
-- invoice the customer already has, and nothing records what was actually sent.
--
-- Also removes the network from the render path. The preview and the PDF read
-- these columns, so neither depends on the n8n webhook being up.
--
-- APPLIED LIVE via MCP apply_migration (invoice_billing_snapshot) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

alter table public.customer_invoices
  add column if not exists billing_name        text,
  add column if not exists billing_line1       text,
  add column if not exists billing_line2       text,
  add column if not exists billing_city        text,
  add column if not exists billing_region      text,
  add column if not exists billing_postal_code text,
  add column if not exists billing_country     text,
  add column if not exists billing_email       text,
  add column if not exists billing_snapshot_at timestamptz;

comment on column public.customer_invoices.billing_snapshot_at is
  'When the Xero contact was copied onto this invoice. The bill-to block is a SNAPSHOT, not a live read: an issued invoice must not silently change its printed address because someone edited the Xero contact months later.';
