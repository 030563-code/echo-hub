-- Reverses 20260904090000_delivery_address_book.sql.
--
-- Dropping the table loses every remembered address. The two invoice columns
-- are dropped too: they are additive and nullable, so nothing else reads them,
-- but any location or requested-by already typed onto an invoice goes with them.
drop table if exists public.customer_delivery_addresses;

alter table public.customer_invoices drop column if exists delivery_requested_by;
alter table public.customer_invoices drop column if exists delivery_location;
