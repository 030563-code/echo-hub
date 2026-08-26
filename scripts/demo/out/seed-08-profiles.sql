begin;

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'BUNNA';

update public.mrp_buffer_profile
set moq = 100, cbm_per_unit = 0.008
where sku = 'BUNNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'CCSNA';

update public.mrp_buffer_profile
set cbm_per_unit = 0.6
where sku = 'CCSNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH10HERCNA';

update public.mrp_buffer_profile
set moq = 30, container_qty = 280, cbm_per_unit = 0.235
where sku = 'EBH10HERCNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH10NA';

update public.mrp_buffer_profile
set moq = 30, container_qty = 280, cbm_per_unit = 0.235
where sku = 'EBH10NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH8NA';

update public.mrp_buffer_profile
set moq = 70, container_qty = 560, cbm_per_unit = 0.09
where sku = 'EBH8NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH9ERNA';

update public.mrp_buffer_profile
set moq = 30, container_qty = 560, cbm_per_unit = 0.118
where sku = 'EBH9ERNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH9NA';

update public.mrp_buffer_profile
set moq = 70, container_qty = 560, cbm_per_unit = 0.118
where sku = 'EBH9NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH9WNA';

update public.mrp_buffer_profile
set moq = 30, container_qty = 560, cbm_per_unit = 0.13
where sku = 'EBH9WNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'container_qty', container_qty, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBH9XNA';

update public.mrp_buffer_profile
set moq = 40, container_qty = 400, cbm_per_unit = 0.165
where sku = 'EBH9XNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'EBVFKNA';

update public.mrp_buffer_profile
set moq = 25, cbm_per_unit = 0.05
where sku = 'EBVFKNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'FSCNA';

update public.mrp_buffer_profile
set cbm_per_unit = 0.6
where sku = 'FSCNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('moq', moq, 'cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'HKNA';

update public.mrp_buffer_profile
set moq = 100, cbm_per_unit = 0.012
where sku = 'HKNA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'M1NA';

update public.mrp_buffer_profile
set cbm_per_unit = 0.4
where sku = 'M1NA';

insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)
select 'andy-demo-2026-08-09', 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object('cbm_per_unit', cbm_per_unit)
from public.mrp_buffer_profile
where sku = 'V2NA';

update public.mrp_buffer_profile
set cbm_per_unit = 0.35
where sku = 'V2NA';

commit;
