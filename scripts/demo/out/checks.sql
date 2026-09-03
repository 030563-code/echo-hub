select jsonb_pretty(jsonb_build_object(
  'row_counts', jsonb_build_object(
    'mrp_demand_events', (select count(*) from public.mrp_demand_events where source_ref like 'DEMO-%'),
    'mrp_stage_weights', (select count(*) from public.mrp_stage_weights where stage_id = 'demo_late_stage'),
    'mrp_lead_time_actuals', (select count(*) from public.mrp_lead_time_actuals where spot_id = 'DEMO'),
    'deals_registry', (select count(*) from public.deals_registry where hubspot_deal_id like 'DEMO-%'),
    'purchase_orders', (select count(*) from public.purchase_orders where po_number like 'DEMO-%'),
    'purchase_order_lines', (select count(*) from public.purchase_order_lines pol join public.purchase_orders po on po.id = pol.po_id where po.po_number like 'DEMO-%'),
    'po_line_receipts', (select count(*) from public.po_line_receipts r join public.purchase_orders po on po.id = r.po_id where po.po_number like 'DEMO-%'),
    'shipment_contents_inserted', (select count(*) from public.shipment_contents where spot_id like 'DEMO-SPOT-%'),
    'shipment_contents_flipped_delivered', (select count(*) from public.mrp_demo_seed_registry where table_name = 'shipment_contents' and op = 'update')
  ),
  'synthetic_demand_by_sku', (
    select coalesce(jsonb_object_agg(sku, total), '{}'::jsonb)
    from (
      select sku, sum(qty) as total
      from public.mrp_demand_events
      where source = 'demo_seed'
      group by sku
      order by sku
    ) t
  )
)) as demo_checks;
