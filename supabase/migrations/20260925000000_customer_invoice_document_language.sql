-- The language a customer invoice is written in.
--
-- Applied live to korylyniwsqtsvzuzydg via MCP apply_migration on 24 Sep 2026
-- (recorded there as 20260924180820), after a dry run inside a rolled-back
-- transaction: 25 rows, all EB-USA, all took 'en'. This file is the repo record
-- of what ran. Never db push.
--
-- Claire invoices French customers mostly and Spanish ones too, and the PDF's
-- labels were English whoever it was for. Its labels and dates now print in
-- English, French or Spanish (src/lib/customer-invoice/invoice-labels.ts).
--
-- Which one is a property of the INVOICE, chosen once and stored here, because
-- the PDF is rendered again at Email and for the Xero attachment and compared
-- with the sha256 taken at Generate. A language worked out afresh at each render
-- could change between the two, making an issued invoice unsendable, or a
-- reprint read differently from the copy the customer holds.
--
-- Opening a draft sets it from the deal's quote in HubSpot (hs_language: fr is
-- French, es is Spanish, anything else English), and the invoice editor changes
-- it while the invoice is still editable. The app writes it directly: the two
-- RPCs that write this table name their columns, so they neither read nor write
-- this one, and neither needed changing.
--
-- Purely additive. Read live before writing this: every existing row is EB-USA,
-- and each takes 'en', which is what each of them printed, so no stored PDF hash
-- changes. No existing constraint, policy, trigger or function is touched, and
-- customer_invoices keeps its RLS with no policies (service role only).

alter table public.customer_invoices
  add column if not exists document_language text not null default 'en'
    constraint customer_invoices_document_language_ck
    check (document_language in ('en', 'fr', 'es'));

comment on column public.customer_invoices.document_language is
  'The language the customer''s PDF prints its labels and dates in: en, fr or es. Chosen when the draft is opened, from the deal''s HubSpot quote (hs_language), and editable until the invoice is numbered. Amounts, tax wording and legal mentions print the same in every language.';
