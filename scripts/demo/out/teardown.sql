begin;

-- 1. Restore UPDATEd rows from registry prior values.
update public.warehouse_stock_levels w
set quantity_on_hand = (r.prior->>'quantity_on_hand')::integer,
    last_counted_at = (r.prior->>'last_counted_at')::timestamptz
from public.mrp_demo_seed_registry r
where r.batch_tag = 'andy-demo-2026-08-09' and r.op = 'update' and r.table_name = 'warehouse_stock_levels'
  and w.warehouse_code = r.pk->>'warehouse_code' and w.sku = r.pk->>'sku';

update public.shipment_contents s
set status = r.prior->>'status',
    delivered_at = (r.prior->>'delivered_at')::timestamptz
from public.mrp_demo_seed_registry r
where r.batch_tag = 'andy-demo-2026-08-09' and r.op = 'update' and r.table_name = 'shipment_contents'
  and s.id = (r.pk->>'id')::uuid;

update public.mrp_buffer_profile p
set moq = case when r.prior ? 'moq' then (r.prior->>'moq')::integer else p.moq end,
    container_qty = case when r.prior ? 'container_qty' then (r.prior->>'container_qty')::integer else p.container_qty end,
    cbm_per_unit = case when r.prior ? 'cbm_per_unit' then (r.prior->>'cbm_per_unit')::numeric else p.cbm_per_unit end
from public.mrp_demo_seed_registry r
where r.batch_tag = 'andy-demo-2026-08-09' and r.op = 'update' and r.table_name = 'mrp_buffer_profile'
  and p.sku = r.pk->>'sku';

-- 2. Delete inserts, FK-safe reverse order (children before parents).
-- 'MRPD-%' covers chains the ENGINE drafts at run time (mrp_draft_po_chain)
-- while demo data is loaded — engine output, so the seed registry never saw
-- them, but they derive from seeded demand and must go too. Guarded to
-- status='requested': a chain a human has ADVANCED (approved/shipped/...) is
-- operationally live and must never be swept by a demo teardown — if any
-- MRPD chain survives this delete, resolve it by hand before rerunning.
delete from public.po_line_receipts rcpt
using public.purchase_orders po
where rcpt.po_id = po.id
  and (po.po_number like 'DEMO-%' or (po.po_number like 'MRPD-%' and po.status = 'requested'));

delete from public.purchase_order_lines pol
using public.purchase_orders po
where pol.po_id = po.id
  and (po.po_number like 'DEMO-%' or (po.po_number like 'MRPD-%' and po.status = 'requested'));

delete from public.purchase_orders
where (po_number like 'DEMO-%' or (po_number like 'MRPD-%' and status = 'requested'))
  and parent_po_id is not null;

delete from public.purchase_orders
where po_number like 'DEMO-%' or (po_number like 'MRPD-%' and status = 'requested');

delete from public.shipment_contents
where spot_id like 'DEMO-SPOT-%';

delete from public.deals_registry
where hubspot_deal_id like 'DEMO-%';

delete from public.mrp_demand_events
where source_ref like 'DEMO-%';

delete from public.mrp_lead_time_actuals
where spot_id = 'DEMO';

delete from public.mrp_stage_weights
where stage_id = 'demo_late_stage';

-- 3. Delete engine output computed from demo inputs. The open-ended >= is
-- DELIBERATE: every engine run between seed and teardown reads the seeded
-- demand/stock/deals, so its output is demo-contaminated whatever its
-- run_date — there is no "legitimate" post-seed run to preserve. After this
-- teardown, run the engine once (--persist) to rebuild real-only rows and
-- profile stats (manifest step 2).
delete from public.mrp_buffer_status_daily
where run_date >= '2026-08-09';

delete from public.mrp_spike_register
where run_date >= '2026-08-09';

-- 4. Drop the registry last.
drop table if exists public.mrp_demo_seed_registry;

commit;
