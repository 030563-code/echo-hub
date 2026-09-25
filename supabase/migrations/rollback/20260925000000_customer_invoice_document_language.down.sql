-- Rollback of 20260925000000_customer_invoice_document_language.sql.
-- Drops the column and its check. Deploy the app without the language code
-- first: the rebuild action selects this column by name. Every invoice then
-- prints in English again, so a French or Spanish invoice that already has a
-- PDF hash from Generate no longer matches it; generate it again before it is
-- sent.
alter table public.customer_invoices
  drop column if exists document_language;
