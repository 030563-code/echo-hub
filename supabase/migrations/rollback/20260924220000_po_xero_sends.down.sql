-- Rollback of 20260924220000_po_xero_sends.sql.
-- Drops the record of hand-offs to Xero. Nothing else reads or writes the table, and no
-- purchase order row changes: the Xero ids n8n wrote back stay on purchase_orders.
drop table if exists public.po_xero_sends;
