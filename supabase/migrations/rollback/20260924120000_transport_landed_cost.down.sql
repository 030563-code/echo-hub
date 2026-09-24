-- Rollback of 20260924120000_transport_landed_cost.sql.
-- Drops every commercial invoice and typed customs cost kept for a shipment. The shipments and
-- their contents stay.
drop function if exists public.transport_save_landed_invoices(uuid, jsonb, jsonb, uuid);
alter table public.transport_shipment_line drop column if exists goods_amount;
alter table public.transport_shipment_line drop column if exists invoice_id;
drop table if exists public.transport_shipment_cost;
drop table if exists public.transport_shipment_invoice;
