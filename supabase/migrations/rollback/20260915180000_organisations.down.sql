-- Rollback for 20260915180000_organisations.sql.
--
-- The grant rows are not recoverable: they were applied by hand and there is
-- no other record of who held which organisation. Take a copy first if that
-- matters:
--
--   create table user_organisations_backup as select * from public.user_organisations;
--
-- The invoices keep every other column; only the organisation stamp goes.

-- 4. The function as it was before organisation_code existed.
create or replace function public.create_customer_invoice(p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reference text;
  v_id uuid;
begin
  v_reference := 'USI' || to_char(now(), 'YYYY') || '-' ||
                 lpad(nextval('public.customer_invoice_seq')::text, 5, '0');

  insert into public.customer_invoices (
    hubspot_deal_id, holding_reference, currency, invoice_date, due_date,
    hubspot_company_id, company_name, taxjar_customer_id, customer_po_number,
    delivery_street, delivery_city, delivery_state, delivery_zip, delivery_country,
    is_collection,
    subtotal, shipping_total, source_lines_snapshot, lines_hash, created_by_uid, updated_by_uid
  ) values (
    p_header->>'hubspot_deal_id',
    v_reference,
    coalesce(p_header->>'currency', 'USD'),
    (p_header->>'invoice_date')::date,
    (p_header->>'due_date')::date,
    p_header->>'hubspot_company_id',
    p_header->>'company_name',
    nullif(btrim(p_header->>'taxjar_customer_id'), ''),
    p_header->>'customer_po_number',
    nullif(btrim(p_header->>'delivery_street'), ''),
    nullif(btrim(p_header->>'delivery_city'), ''),
    nullif(btrim(upper(p_header->>'delivery_state')), ''),
    nullif(btrim(p_header->>'delivery_zip'), ''),
    coalesce(p_header->>'delivery_country', 'US'),
    coalesce((p_header->>'is_collection')::boolean, false),
    (p_header->>'subtotal')::numeric,
    (p_header->>'shipping_total')::numeric,
    p_header->'source_lines_snapshot',
    p_header->>'lines_hash',
    (p_header->>'created_by_uid')::uuid,
    (p_header->>'created_by_uid')::uuid
  ) returning id into v_id;

  insert into public.customer_invoice_lines (
    invoice_id, line_key, sort_order, origin, parent_line_key,
    hs_line_item_id, hs_product_id, sku, xero_item_code, account_code,
    name, description, quantity, unit_price, discount_percentage, line_total,
    is_shipping, ship_from_depot, ship_from_locked
  )
  select
    v_id,
    l->>'line_key',
    coalesce((l->>'sort_order')::int, 0),
    coalesce(l->>'origin', 'hubspot'),
    l->>'parent_line_key',
    l->>'hs_line_item_id',
    l->>'hs_product_id',
    l->>'sku',
    l->>'xero_item_code',
    l->>'account_code',
    coalesce(l->>'name', ''),
    l->>'description',
    coalesce((l->>'quantity')::numeric, 0),
    coalesce((l->>'unit_price')::numeric, 0),
    coalesce((l->>'discount_percentage')::numeric, 0),
    coalesce((l->>'line_total')::numeric, 0),
    coalesce((l->>'is_shipping')::boolean, false),
    l->>'ship_from_depot',
    coalesce((l->>'ship_from_locked')::boolean, false)
  from jsonb_array_elements(p_lines) as l;

  insert into public.customer_invoice_events (invoice_id, event, actor_uid, payload)
  values (v_id, 'created', (p_header->>'created_by_uid')::uuid,
          jsonb_build_object(
            'holding_reference', v_reference,
            'is_collection', coalesce((p_header->>'is_collection')::boolean, false)
          ));

  return jsonb_build_object('id', v_id, 'holding_reference', v_reference);
end;
$function$;

-- 3.
drop index if exists public.customer_invoices_organisation_status_idx;
alter table public.customer_invoices drop column if exists organisation_code;

-- 2.
drop table if exists public.user_organisations;

-- 1. The three rows this migration added, and the tenant ids it filled in.
delete from public.entities where code in ('EB-FRANCE', 'EB-AUSTRALIA', 'EB-UK');
update public.entities set xero_tenant_id = null
where code in ('EB-USA', 'EB-CANADA', 'EB-GROUP', 'EB-SRO');
