-- Rollback of 20260923170000_cargo_tracked_spots_and_references.sql.
-- Drops the hand-added SPOT IDs and every reference typed on a shipment. The shipments themselves
-- stay in cargo_shipment; a hand-added one stops being refreshed.
drop table if exists public.cargo_shipment_reference;
drop table if exists public.cargo_tracked_spot;
