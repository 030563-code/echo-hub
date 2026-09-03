-- Atomic draft save for customer invoices: status guard, full line replace,
-- server-side tax preservation (never client-supplied), explicit overrides,
-- header totals, staleness handling and the audit event in one transaction.
-- APPLIED LIVE via MCP apply_migration (customer_invoice_save_rpc) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

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
begin
  select status into v_status
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
  create temp table _old_line_tax on commit drop as
    select line_key, tax_amount, taxable_amount, combined_tax_rate, tax_override
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
    set tax_amount = o.tax_amount,
        taxable_amount = o.taxable_amount,
        combined_tax_rate = o.combined_tax_rate,
        tax_override = o.tax_override
    from _old_line_tax o
    where nl.invoice_id = p_invoice_id and nl.line_key = o.line_key;

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
      delivery_street = p_header->>'delivery_street',
      delivery_city = p_header->>'delivery_city',
      delivery_state = p_header->>'delivery_state',
      delivery_zip = p_header->>'delivery_zip',
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
  where id = p_invoice_id;

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
    jsonb_build_object('preserve_tax', p_preserve_tax, 'overrides', p_overrides)
  );

  return jsonb_build_object(
    'status', case when v_invalidated then 'draft' else v_status end,
    'tax_invalidated', v_invalidated
  );
end;
$$;

revoke all on function public.save_customer_invoice(uuid, jsonb, jsonb, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_customer_invoice(uuid, jsonb, jsonb, uuid, boolean, text, jsonb) to service_role;
