-- Rollback for 20260903120000_invoice_stages.
-- Any invoice sitting in a stage this removes must be moved first, or the
-- constraint will refuse to apply.

alter table public.customer_invoices drop constraint if exists customer_invoices_status_check;
alter table public.customer_invoices add constraint customer_invoices_status_check
  check (status in ('draft','tax_calculated','authorizing','raised','sent','authorized','completed','voided'));

drop index if exists public.customer_invoices_customer_number_unique;

alter table public.customer_invoices
  drop column if exists pdf_generated_at,
  drop column if exists pdf_storage_path,
  drop column if exists pdf_sha256,
  drop column if exists xero_attachment_id,
  drop column if exists payment_terms_label,
  drop column if exists emailed_to,
  drop column if exists emailed_was_test;
