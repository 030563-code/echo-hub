-- Rollback for 20260903160000_deals_registry_collection.sql.
--
-- Dropping the column fires no row trigger. Any customer_invoices row already
-- seeded from it keeps its own is_collection, which is the value the tax
-- calculation and the filing actually read, so no invoice changes jurisdiction
-- because of this. Nothing else reads the column.
alter table public.deals_registry drop column if exists is_collection;
