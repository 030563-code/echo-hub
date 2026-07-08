-- Cargo/transport leg as a real child PO. Juraj's unified numbering wants the
-- cargo-partner order to be a raised, numbered child of the SRO order
-- (PO-001 → PO-001-2), not just a SPOT-ID lookup. Add SRO_TO_CARGO to the leg
-- CHECK. It is a SIBLING of SRO_TO_SUPPLIER (both children of the EB_GROUP_TO_SRO
-- order), raised via service-role from the transport module — it does NOT enter
-- the intercompany approval queue, so the raise/approve RLS policies are unchanged.
alter table public.purchase_orders drop constraint if exists purchase_orders_leg_check;
alter table public.purchase_orders
  add constraint purchase_orders_leg_check
  check (leg = any (array['DEPOT_TO_EB_GROUP','EB_GROUP_TO_SRO','SRO_TO_SUPPLIER','SRO_TO_CARGO']));
