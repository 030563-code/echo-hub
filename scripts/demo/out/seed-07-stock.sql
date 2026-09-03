begin;

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBH9NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBH9NA';

update public.warehouse_stock_levels
set quantity_on_hand = 350, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBH9NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"HKNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'HKNA';

update public.warehouse_stock_levels
set quantity_on_hand = 480, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'HKNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"BUNNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'BUNNA';

update public.warehouse_stock_levels
set quantity_on_hand = 420, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'BUNNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBH10HERCNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBH10HERCNA';

update public.warehouse_stock_levels
set quantity_on_hand = 340, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBH10HERCNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBH10NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBH10NA';

update public.warehouse_stock_levels
set quantity_on_hand = 60, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBH10NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBH9XNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBH9XNA';

update public.warehouse_stock_levels
set quantity_on_hand = 170, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBH9XNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBVFKNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBVFKNA';

update public.warehouse_stock_levels
set quantity_on_hand = 12, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBVFKNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBH8NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBH8NA';

update public.warehouse_stock_levels
set quantity_on_hand = 90, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBH8NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"EBH9WNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'EBH9WNA';

update public.warehouse_stock_levels
set quantity_on_hand = 30, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'EBH9WNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"M1NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'M1NA';

update public.warehouse_stock_levels
set quantity_on_hand = 20, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'M1NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"V2NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'V2NA';

update public.warehouse_stock_levels
set quantity_on_hand = 15, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'V2NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"CCSNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'CCSNA';

update public.warehouse_stock_levels
set quantity_on_hand = 6, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'CCSNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-BAL","sku":"FSCNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-BAL' and sku = 'FSCNA';

update public.warehouse_stock_levels
set quantity_on_hand = 5, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-BAL' and sku = 'FSCNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-SBD","sku":"EBH9NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-SBD' and sku = 'EBH9NA';

update public.warehouse_stock_levels
set quantity_on_hand = 100, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-SBD' and sku = 'EBH9NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-SBD","sku":"EBH10NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-SBD' and sku = 'EBH10NA';

update public.warehouse_stock_levels
set quantity_on_hand = 40, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-SBD' and sku = 'EBH10NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-SBD","sku":"EBH9ERNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-SBD' and sku = 'EBH9ERNA';

update public.warehouse_stock_levels
set quantity_on_hand = 70, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-SBD' and sku = 'EBH9ERNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-SBD","sku":"EBH9XNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-SBD' and sku = 'EBH9XNA';

update public.warehouse_stock_levels
set quantity_on_hand = 60, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-SBD' and sku = 'EBH9XNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"US-SBD","sku":"EBH8NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'US-SBD' and sku = 'EBH8NA';

update public.warehouse_stock_levels
set quantity_on_hand = 35, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'US-SBD' and sku = 'EBH8NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"CA-HAM","sku":"EBH9NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'CA-HAM' and sku = 'EBH9NA';

update public.warehouse_stock_levels
set quantity_on_hand = 50, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'CA-HAM' and sku = 'EBH9NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"CA-HAM","sku":"EBH10NA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'CA-HAM' and sku = 'EBH10NA';

update public.warehouse_stock_levels
set quantity_on_hand = 35, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'CA-HAM' and sku = 'EBH10NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"CA-HAM","sku":"HKNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'CA-HAM' and sku = 'HKNA';

update public.warehouse_stock_levels
set quantity_on_hand = 130, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'CA-HAM' and sku = 'HKNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"CA-HAM","sku":"BUNNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'CA-HAM' and sku = 'BUNNA';

update public.warehouse_stock_levels
set quantity_on_hand = 90, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'CA-HAM' and sku = 'BUNNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'warehouse_stock_levels', '{"warehouse_code":"CA-HAM","sku":"EBH10HERCNA"}'::jsonb, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)
from public.warehouse_stock_levels
where warehouse_code = 'CA-HAM' and sku = 'EBH10HERCNA';

update public.warehouse_stock_levels
set quantity_on_hand = 110, last_counted_at = '2026-08-07T09:00:00Z'
where warehouse_code = 'CA-HAM' and sku = 'EBH10HERCNA';

commit;
