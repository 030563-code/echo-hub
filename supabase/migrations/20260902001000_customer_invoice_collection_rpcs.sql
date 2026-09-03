-- Thread the collection flag through the create and save RPCs.
--
-- Both keep their EXISTING signatures: the flag rides inside p_header the same
-- way delivery_street does. Adding a parameter would leave the old overload
-- resolvable and callable, which is a live foot-gun.
--
-- APPLIED LIVE via MCP apply_migration (customer_invoice_collection_rpcs) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

create or replace function public.create_customer_invoice(p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number text;
  v_id uuid;
begin
  v_number := 'USI' || to_char(now(), 'YYYY') || '-' ||
              lpad(nextval('public.customer_invoice_seq')::text, 5, '0');

  insert into public.customer_invoices (
    hubspot_deal_id, invoice_number, currency, invoice_date, due_date,
    hubspot_company_id, company_name, taxjar_customer_id, customer_po_number,
    delivery_street, delivery_city, delivery_state, delivery_zip, delivery_country,
    is_collection,
    subtotal, shipping_total, source_lines_snapshot, lines_hash, created_by_uid, updated_by_uid
  ) values (
    p_header->>'hubspot_deal_id',
    v_number,
    coalesce(p_header->>'currency', 'USD'),
    coalesce((p_header->>'invoice_date')::date, (now() at time zone 'utc')::date),
    (p_header->>'due_date')::date,
    p_header->>'hubspot_company_id',
    p_header->>'company_name',
    p_header->>'taxjar_customer_id',
    p_header->>'customer_po_number',
    nullif(btrim(p_header->>'delivery_street'), ''),
    nullif(btrim(p_header->>'delivery_city'), ''),
    nullif(btrim(upper(p_header->>'delivery_state')), ''),
    nullif(btrim(p_header->>'delivery_zip'), ''),
    coalesce(p_header->>'delivery_country', 'US'),
    -- A rebuilt draft carries the flag forward; a fresh draft defaults to
    -- delivered. Losing it here would silently re-tax a Will Call order at the
    -- customer's own address.
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
            'invoice_number', v_number,
            'is_collection', coalesce((p_header->>'is_collection')::boolean, false)
          ));

  return jsonb_build_object('id', v_id, 'invoice_number', v_number);
end;
$$;

revoke all on function public.create_customer_invoice(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_customer_invoice(jsonb, jsonb) to service_role;


create or replace function public.save_customer_invoice(
  p_invoice_id uuid,
  p_header jsonb,
  p_lines jsonb,
  p_actor uuid,
  p_preserve_tax boolean,
  p_new_hash text,
  p_overrides jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_subtotal numeric(12,2);
  v_shipping numeric(12,2);
  v_tax numeric(12,2);
  v_invalidated boolean := false;
  v_old_collection boolean;
  v_new_collection boolean;
  v_old_tax jsonb;
begin
  select status, is_collection into v_status, v_old_collection
  from public.customer_invoices
  where id = p_invoice_id
  for update;

  if v_status is null then
    raise exception 'INVOICE_NOT_FOUND';
  end if;
  if v_status not in ('draft', 'tax_calculated') then
    raise exception 'INVALID_STATUS:%', v_status;
  end if;

  -- Stash the current per-line tax results so an unchanged (same-hash) save
  -- keeps them without ever trusting client-supplied tax figures.
  -- A jsonb variable rather than a temp table: `on commit drop` only drops at
  -- COMMIT, so a temp table made this function fail on its second call inside
  -- one transaction ("relation _old_line_tax already exists").
  select coalesce(
           jsonb_object_agg(
             line_key,
             jsonb_build_object(
               'tax_amount', tax_amount,
               'taxable_amount', taxable_amount,
               'combined_tax_rate', combined_tax_rate,
               'tax_override', tax_override
             )
           ),
           '{}'::jsonb
         )
  into v_old_tax
  from public.customer_invoice_lines
  where invoice_id = p_invoice_id;

  delete from public.customer_invoice_lines where invoice_id = p_invoice_id;

  insert into public.customer_invoice_lines (
    invoice_id, line_key, sort_order, origin, parent_line_key,
    hs_line_item_id, hs_product_id, sku, xero_item_code, account_code,
    name, description, quantity, unit_price, discount_percentage, line_total,
    is_shipping, ship_from_depot, ship_from_locked
  )
  select
    p_invoice_id,
    l->>'line_key',
    coalesce((l->>'sort_order')::int, 0),
    coalesce(l->>'origin', 'manual'),
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

  if p_preserve_tax then
    update public.customer_invoice_lines nl
    set tax_amount = (v_old_tax -> nl.line_key ->> 'tax_amount')::numeric,
        taxable_amount = (v_old_tax -> nl.line_key ->> 'taxable_amount')::numeric,
        combined_tax_rate = (v_old_tax -> nl.line_key ->> 'combined_tax_rate')::numeric,
        tax_override = coalesce((v_old_tax -> nl.line_key ->> 'tax_override')::boolean, false)
    where nl.invoice_id = p_invoice_id and v_old_tax ? nl.line_key;

    -- Explicit reviewer overrides of the tax amount, applied after
    -- preservation and flagged so the divergence from TaxJar is visible.
    update public.customer_invoice_lines nl
    set tax_amount = (ov->>'tax_amount')::numeric,
        tax_override = true
    from jsonb_array_elements(p_overrides) as ov
    where nl.invoice_id = p_invoice_id and nl.line_key = ov->>'line_key';
  end if;

  select
    coalesce(sum(line_total) filter (where not is_shipping), 0),
    coalesce(sum(line_total) filter (where is_shipping), 0),
    sum(tax_amount)
  into v_subtotal, v_shipping, v_tax
  from public.customer_invoice_lines
  where invoice_id = p_invoice_id;

  if v_status = 'tax_calculated' and not p_preserve_tax then
    v_invalidated := true;
  end if;

  update public.customer_invoices
  set customer_po_number = p_header->>'customer_po_number',
      taxjar_customer_id = nullif(p_header->>'taxjar_customer_id', ''),
      invoice_date = coalesce((p_header->>'invoice_date')::date, invoice_date),
      due_date = (p_header->>'due_date')::date,
      delivery_street = nullif(btrim(p_header->>'delivery_street'), ''),
      delivery_city = nullif(btrim(p_header->>'delivery_city'), ''),
      delivery_state = nullif(btrim(upper(p_header->>'delivery_state')), ''),
      delivery_zip = nullif(btrim(p_header->>'delivery_zip'), ''),
      -- coalesce onto the STORED value, never onto false: an absent key must
      -- preserve a collected invoice rather than silently changing the
      -- jurisdiction its tax is calculated in. An explicit false still saves.
      is_collection = coalesce((p_header->>'is_collection')::boolean, is_collection),
      subtotal = v_subtotal,
      shipping_total = v_shipping,
      tax_total = case when v_invalidated then null else v_tax end,
      total = case
        when v_invalidated or v_tax is null then null
        else v_subtotal + v_shipping + v_tax
      end,
      tax_calculated_at = case when v_invalidated then null else tax_calculated_at end,
      taxjar_request = case when v_invalidated then null else taxjar_request end,
      taxjar_response = case when v_invalidated then null else taxjar_response end,
      status = case when v_invalidated then 'draft' else status end,
      lines_hash = p_new_hash,
      updated_by_uid = p_actor,
      updated_at = now()
  where id = p_invoice_id
  returning is_collection into v_new_collection;

  if v_invalidated then
    update public.customer_invoice_lines
    set tax_amount = null, taxable_amount = null, combined_tax_rate = null, tax_override = false
    where invoice_id = p_invoice_id;
  end if;

  insert into public.customer_invoice_events (invoice_id, event, actor_uid, payload)
  values (
    p_invoice_id,
    case when v_invalidated then 'tax_invalidated' else 'saved' end,
    p_actor,
    jsonb_build_object(
      'preserve_tax', p_preserve_tax,
      'overrides', p_overrides,
      'is_collection', v_new_collection
    )
  );

  -- A jurisdiction change is the row an auditor wants six months later, so it
  -- gets its own event rather than being buried in the save payload.
  if v_old_collection is distinct from v_new_collection then
    insert into public.customer_invoice_events (invoice_id, event, actor_uid, payload)
    values (
      p_invoice_id,
      'collection_changed',
      p_actor,
      jsonb_build_object('from', v_old_collection, 'to', v_new_collection)
    );
  end if;

  return jsonb_build_object(
    'status', case when v_invalidated then 'draft' else v_status end,
    'tax_invalidated', v_invalidated,
    'is_collection', v_new_collection
  );
end;
$$;

revoke all on function public.save_customer_invoice(uuid, jsonb, jsonb, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_customer_invoice(uuid, jsonb, jsonb, uuid, boolean, text, jsonb) to service_role;
