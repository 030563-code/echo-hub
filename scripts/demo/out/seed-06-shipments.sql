begin;

set local session_replication_role = replica;

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'shipment_contents', jsonb_build_object('id', id), jsonb_build_object('status', status, 'delivered_at', delivered_at)
from public.shipment_contents
where status <> 'delivered' and spot_id not like 'DEMO-%' and eta < '2026-05-01';

update public.shipment_contents
set status = 'delivered', delivered_at = eta + interval '3 days'
where status <> 'delivered' and spot_id not like 'DEMO-%' and eta < '2026-05-01';

insert into public.shipment_contents (id, spot_id, container_ref, sku, product_name, qty, depot_destination, status, shipped_at, eta, delivered_at, po_reference, po_id) values
  ('00000000-de30-4000-8000-000000000032', 'DEMO-SPOT-01', 'DEMO-CNT-01', 'EBH9NA', 'Echo Barrier H9', 560, 'US-BAL', 'on_water', '2026-07-28', '2026-08-27', null, 'DEMO-EBUS26102', '00000000-de30-4000-8000-000000000030'),
  ('00000000-de30-4000-8000-000000000033', 'DEMO-SPOT-02', 'DEMO-CNT-02', 'EBH10HERCNA', 'Echo Barrier H10 HERC', 280, 'US-BAL', 'on_water', '2026-08-02', '2026-09-03', null, null, null),
  ('00000000-de30-4000-8000-000000000034', 'DEMO-SPOT-02', 'DEMO-CNT-02', 'EBVFKNA', 'Vertical Fitting Kits', 40, 'US-BAL', 'on_water', '2026-08-02', '2026-09-03', null, null, null);

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior) values
  ('andy-demo-2026-08-09', 'insert', 'shipment_contents', '{"id":"00000000-de30-4000-8000-000000000032"}'::jsonb, null),
  ('andy-demo-2026-08-09', 'insert', 'shipment_contents', '{"id":"00000000-de30-4000-8000-000000000033"}'::jsonb, null),
  ('andy-demo-2026-08-09', 'insert', 'shipment_contents', '{"id":"00000000-de30-4000-8000-000000000034"}'::jsonb, null);

commit;
