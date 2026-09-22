-- The holding reference names its organisation.
--
-- create_customer_invoice minted every draft's internal reference as
-- 'USI' || year || '-' || sequence, for everyone. The prefix is internal and
-- gaps in it are harmless, but with France posting a DRAFT to Xero to price
-- the tax (Dean, 22 Sep 2026), the holding reference is what that Xero draft
-- is called until the real EBFR number replaces it at authorise. A French draft
-- in Echo Barrier SAS's Xero called USI2026-00027 would be wrong on its face.
--
-- One optional header key, `holding_prefix`, defaulting to 'USI' so every
-- existing caller is byte-for-byte unaffected. The sequence stays shared: it
-- only has to be unique, not gapless, and one counter cannot collide with
-- itself. Nothing else in the function changes.

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
  v_reference := coalesce(nullif(btrim(p_header->>'holding_prefix'), ''), 'USI')
                 || to_char(now(), 'YYYY') || '-' ||
                 lpad(nextval('public.customer_invoice_seq')::text, 5, '0');

  insert into public.customer_invoices (
    hubspot_deal_id, holding_reference, organisation_code, currency, invoice_date, due_date,
    hubspot_company_id, company_name, taxjar_customer_id, customer_po_number,
    delivery_street, delivery_city, delivery_state, delivery_zip, delivery_country,
    is_collection,
    subtotal, shipping_total, source_lines_snapshot, lines_hash, created_by_uid, updated_by_uid
  ) values (
    p_header->>'hubspot_deal_id',
    v_reference,
    p_header->>'organisation_code',
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

do $$
declare
  body text;
begin
  select pg_get_functiondef(oid) into body from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'create_customer_invoice';
  if position('holding_prefix' in body) = 0 then
    raise exception 'create_customer_invoice did not take the holding_prefix key';
  end if;
  if position('''USI''' in body) = 0 then
    raise exception 'the USI default was lost, so existing callers would change';
  end if;
end $$;
