-- Rollback of 20260924090000_transport_shipments.sql.
-- Drops every shipment kept by hand and every contents line typed on a shipment. The Cargo Partner
-- shipments themselves stay in cargo_shipment.
drop function if exists public.transport_save_shipment_lines(uuid, jsonb, uuid);
drop table if exists public.transport_shipment_line;
drop table if exists public.transport_shipment;
