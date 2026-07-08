-- Structural link from a shipment line back to its purchase order. Today the only
-- join is a loose text `po_reference`, and the Cargo/ingestion refs (Unleashed
-- EBG#) don't match Hub PO numbers — so the PO↔shipment↔invoice thread is broken.
-- This nullable `po_id` lets the Hub's own Add-Shipment path resolve the reference
-- to a real PO and store the link; it stays null for ingested rows whose ref isn't
-- a Hub PO#, and starts matching once the Hub sends its own PO# to Cargo
-- (post-Unleashed). Plain uuid (no FK) to avoid any coupling with the shared
-- ingestion or a PO-delete blocking a shipment row.
alter table public.shipment_contents add column if not exists po_id uuid;
create index if not exists shipment_contents_po_id_idx on public.shipment_contents (po_id) where po_id is not null;
