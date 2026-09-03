-- Atomic tax application for customer invoices. Replaces a per-line update
-- loop in calculate-tax.ts that keyed on row uuids read before the TaxJar
-- calls: a concurrent save (which replaces lines DELETE+INSERT, minting new
-- uuids) made those writes silently hit zero rows, leaving an invoice marked
-- tax_calculated with no per-line tax.
--
-- Lines are matched by the stable line_key, the whole application is one
-- transaction, and it is guarded on BOTH the status and the lines_hash the
-- calculation was performed against, so a save that happened mid-calculation
-- makes the application fail instead of writing stale tax.
-- APPLIED LIVE via MCP apply_migration (customer_invoice_tax_rpc) on
-- korylyniwsqtsvzuzydg. Repo mirror. Never `db push`.

create or replace function public.apply_customer_invoice_tax(
  p_invoice_id uuid,
  p_expected_hash text,
  p_line_tax jsonb,
  p_totals jsonb,
  p_request jsonb,
  p_response jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_hash text;
  v_missing int;
begin
  select status, lines_hash into v_status, v_hash
  from public.customer_invoices
  where id = p_invoice_id
  for update;

  if v_status is null then
    raise exception 'INVOICE_NOT_FOUND';
  end if;
  if v_status not in ('draft', 'tax_calculated') then
    raise exception 'INVALID_STATUS:%', v_status;
  end if;
  -- The hash is null on a freshly built draft that has never been saved; in
  -- that case only the status guard applies.
  if v_hash is not null and v_hash is distinct from p_expected_hash then
    raise exception 'STALE_CALCULATION';
  end if;

  -- Every line the calculation covered must still exist under the same key.
  select count(*) into v_missing
  from jsonb_array_elements(p_line_tax) as t
  where not exists (
    select 1 from public.customer_invoice_lines l
    where l.invoice_id = p_invoice_id and l.line_key = t->>'line_key'
  );
  if v_missing > 0 then
    raise exception 'STALE_CALCULATION';
  end if;

  update public.customer_invoice_lines l
  set tax_amount = (t->>'tax_amount')::numeric,
      taxable_amount = (t->>'taxable_amount')::numeric,
      combined_tax_rate = (t->>'combined_tax_rate')::numeric,
      tax_override = false
  from jsonb_array_elements(p_line_tax) as t
  where l.invoice_id = p_invoice_id and l.line_key = t->>'line_key';

  -- Lines the calculation did not cover carry no tax.
  update public.customer_invoice_lines l
  set tax_amount = 0, taxable_amount = null, combined_tax_rate = null, tax_override = false
  where l.invoice_id = p_invoice_id
    and not exists (
      select 1 from jsonb_array_elements(p_line_tax) as t
      where t->>'line_key' = l.line_key
    );

  update public.customer_invoices
  set subtotal = (p_totals->>'subtotal')::numeric,
      shipping_total = (p_totals->>'shipping_total')::numeric,
      tax_total = (p_totals->>'tax_total')::numeric,
      total = (p_totals->>'total')::numeric,
      taxjar_request = p_request,
      taxjar_response = p_response,
      tax_calculated_at = now(),
      lines_hash = p_expected_hash,
      status = 'tax_calculated',
      error_message = null,
      updated_by_uid = p_actor,
      updated_at = now()
  where id = p_invoice_id;

  insert into public.customer_invoice_events (invoice_id, event, actor_uid, payload)
  values (p_invoice_id, 'tax_calculated', p_actor, p_totals);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.apply_customer_invoice_tax(uuid, text, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.apply_customer_invoice_tax(uuid, text, jsonb, jsonb, jsonb, jsonb, uuid) to service_role;
