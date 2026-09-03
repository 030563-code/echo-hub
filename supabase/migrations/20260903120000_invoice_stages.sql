-- The invoicing pipeline, reordered (Dean, 2026-09-03).
--
-- Old order: Save draft -> Send to Xero (number allocated) -> Send to TaxJar.
-- New order: Save draft -> Preview -> Send to TaxJar (number allocated here)
--            -> Generate PDF -> Email the customer -> Send to Xero + attach PDF.
--
-- Xero moves to LAST because the customer-facing document is a PDF from the Hub
-- and Xero is the book of record only. The number moves to Send to TaxJar
-- because the filing is keyed on it, and because that is the first step that
-- commits anything outward. Drafts still carry a holding reference, so an
-- abandoned draft still burns nothing.
--
-- Costs no data migration: no invoice has ever passed tax_calculated. Live today
-- is 4 voided rows and 1 tax_calculated.
--
-- Additive only. Never `db push`.

-- 1. Two new stages, one per step that now has its own button and its own queue.
--    'raised' and 'authorized' stay in the constraint but are no longer written:
--    dropping a value a live CHECK still references is how you break a rollback.
alter table public.customer_invoices drop constraint if exists customer_invoices_status_check;
alter table public.customer_invoices add constraint customer_invoices_status_check
  check (status in (
    'draft',            -- opened from an accepted quote, tax not calculated
    'tax_calculated',   -- Save draft has run
    'filed',            -- TaxJar order transaction created, EBUS number allocated
    'documented',       -- invoice PDF generated
    'sent',             -- PDF emailed to the customer
    'authorizing',      -- the Xero call is in flight
    'completed',        -- in Xero with the PDF attached
    'raised',           -- legacy, no longer written
    'authorized',       -- legacy, no longer written
    'voided'
  ));

-- 2. THE UNIQUE INDEX ON invoice_number DOES NOT EXIST, despite a migration that
--    reads as though it created one.
--
--    20260902004000 renamed invoice_number to holding_reference. The base
--    table's `invoice_number text not null unique` constraint followed the
--    rename and kept its ORIGINAL NAME, customer_invoices_invoice_number_key.
--    The new `create unique index if not exists
--    customer_invoices_invoice_number_key ... (invoice_number)` then matched
--    that existing name and did nothing at all. Verified live 2026-09-03:
--    customer_invoices_invoice_number_key is a unique index on
--    holding_reference, and no index on invoice_number exists.
--
--    So nothing has been stopping two invoices carrying the same EBUS number.
--    Harmless only because none has ever been allocated. Named differently on
--    purpose, so it cannot collide the same way again.
create unique index if not exists customer_invoices_customer_number_unique
  on public.customer_invoices (invoice_number)
  where invoice_number is not null;

-- 3. The document. Stored once at Generate PDF so the bytes emailed to the
--    customer, attached to Xero and re-downloaded later are the same bytes.
--    Re-rendering on demand would let a renderer change six months from now
--    silently produce a different document for the same EBUS number.
alter table public.customer_invoices
  add column if not exists pdf_generated_at timestamptz,
  add column if not exists pdf_storage_path text,
  add column if not exists pdf_sha256      text,
  add column if not exists xero_attachment_id text;

-- 4. The payment terms as WORDS, snapshotted.
--    describeTerms() output lives only in a client card today and is re-derived
--    from a live Xero lookup every time. An issued invoice must not change its
--    printed terms because someone edited the Xero contact afterwards.
alter table public.customer_invoices
  add column if not exists payment_terms_label text;

-- 5. Who the invoice was emailed to, and whether that was a test send.
--    emailed_at already records THAT it went; neither records where, and a test
--    send that looks identical to a real one in the audit trail is a trap.
alter table public.customer_invoices
  add column if not exists emailed_to text,
  add column if not exists emailed_was_test boolean not null default false;

comment on column public.customer_invoices.emailed_was_test is
  'True when INVOICE_EMAIL_TEST_RECIPIENT redirected the send away from the '
  'customer. Without this a test send and a real one are indistinguishable '
  'after the fact.';
