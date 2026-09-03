-- Collection ("Will Call"): the customer collects from the depot, so US sales
-- tax is due at the ship-from depot rather than at the delivery address.
-- Header-level flag: one invoice is wholly collected or wholly delivered. A
-- mixed order is two invoices (see docs/us-invoicing.md).
-- APPLIED LIVE via MCP apply_migration (customer_invoice_collection) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

alter table public.customer_invoices
  add column if not exists is_collection boolean not null default false;

comment on column public.customer_invoices.is_collection is
  'Will Call. When true the TaxJar destination is the line''s own ship-from depot '
  'address, not delivery_*. Part of lines_hash, so flipping it invalidates any '
  'calculated tax.';
