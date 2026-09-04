-- Saving ANY invoice draft has been broken since 2026-09-03.
--
-- 20260903141000_save_invoice_persists_tracking.sql patched the live function
-- with two string replacements. The first appended `tracking` to the END of the
-- INSERT's column list. The second inserted the tracking VALUE immediately
-- after `is_shipping`, in the MIDDLE of the values list. The two no longer line
-- up, so the last four columns received:
--
--   is_shipping       <- is_shipping          (correct)
--   ship_from_depot   <- tracking      jsonb
--   ship_from_locked  <- ship_from_depot text
--   tracking          <- ship_from_locked boolean
--
-- Postgres rejects the plan outright:
--   column "ship_from_locked" is of type boolean but expression is of type text
--   (SQLSTATE 42804)
--
-- That is a PLAN-TIME error, so every call failed, whatever the invoice held.
-- The Hub reports it as the generic "Could not save the invoice.", which is why
-- it read as a data problem with one particular line or delivery address.
--
-- The old migration's guard only checked that its anchors MATCHED, never that
-- the value it inserted landed in the position its column did. Hence the
-- verification at the bottom of this file, which actually calls the function.
--
-- Written out in full rather than string-patched again, from the live
-- definition read with pg_get_functiondef immediately before this change. The
-- ONLY difference is the order of the last three values.
CREATE OR REPLACE FUNCTION public.save_customer_invoice(p_invoice_id uuid, p_header jsonb, p_lines jsonb, p_actor uuid, p_preserve_tax boolean, p_new_hash text, p_overrides jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    is_shipping, ship_from_depot, ship_from_locked, tracking
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
    coalesce((l->>'ship_from_locked')::boolean, false),
    -- Xero tracking, max 2 per line, guarded by a CHECK on the column.
    -- KEEP THIS LAST. The column list above ends with `tracking`, and moving
    -- this value up shifts every column after it by one, which is exactly the
    -- bug this migration exists to undo.
    coalesce(l->'tracking', '[]'::jsonb)
  from jsonb_array_elements(p_lines) as l;

  if p_preserve_tax then
    update public.customer_invoice_lines nl
    set tax_amount = (v_old_tax -> nl.line_key ->> 'tax_amount')::numeric,
        taxable_amount = (v_old_tax -> nl.line_key ->> 'taxable_amount')::numeric,
        combined_tax_rate = (v_old_tax -> nl.line_key ->> 'combined_tax_rate')::numeric,
        tax_override = coalesce((v_old_tax -> nl.line_key ->> 'tax_override')::boolean, false)
    where nl.invoice_id = p_invoice_id and v_old_tax ? nl.line_key;

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
      invoice_date = case when jsonb_exists(p_header, 'invoice_date') then (p_header->>'invoice_date')::date else invoice_date end,
      due_date = (p_header->>'due_date')::date,
      delivery_street = nullif(btrim(p_header->>'delivery_street'), ''),
      delivery_city = nullif(btrim(p_header->>'delivery_city'), ''),
      delivery_state = nullif(btrim(upper(p_header->>'delivery_state')), ''),
      delivery_zip = nullif(btrim(p_header->>'delivery_zip'), ''),
      delivery_location = nullif(btrim(p_header->>'delivery_location'), ''),
      delivery_requested_by = nullif(btrim(p_header->>'delivery_requested_by'), ''),
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
$function$;
