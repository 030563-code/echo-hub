-- HS codes on every commercial invoice, and a third leg: Group to Canada.
--
-- Dean, 14 Sep 2026: "the hs codes must be in the commercial invoice from sro
-- to group and group to depots". The invoice already prints an HS code column
-- and generation already fills it from product_hs_codes by sku and leg, but the
-- table is empty, nothing checks what goes into it, and the Hub refuses nothing
-- when a line has no code. The app now refuses to issue an invoice with a blank
-- HS code on any line, and /invoices/hs-codes is where the codes are entered.
-- This migration is the database half of that.
--
-- What changes:
--  - entities: EB-CANADA, Echo Barrier Canada, Inc, invoicing in CAD. The
--    registered address and tax ids are not known yet, so they are placeholders
--    to confirm, the same way the other entities started. No Xero tenant id:
--    none of the existing entity rows carries one.
--  - intercompany_prices: a GROUP_TO_CANADA row for each GROUP_TO_USA row
--    whose product is sold in Canada, with the same EUR base. "Sold in Canada"
--    means its product_code_master row has a code_canada, reached through
--    po_product_catalog.internal_sku, the same join the n8n workflow uses. The
--    HS codes tab only asks for a Canada code where a Canada price exists, so
--    seeding every USA product would demand codes for products never sold
--    there. Like the USA leg these are COST-LEVEL PLACEHOLDERS
--    pending Dave and Juraj; the Canada invoice converts the EUR base to CAD at
--    the EUR_CAD rate from fx_weekly, snapshotted on the invoice.
--  - invoice_composition_rules: each rule scoped to GROUP_TO_USA is copied to
--    GROUP_TO_CANADA with the same rule, and a note saying it mirrors the USA
--    rule and needs confirming.
--  - product_hs_codes: a CHECK on leg (the three invoice legs), and a CHECK on
--    hs_code: digits, dots and single spaces only, starting and ending with a
--    digit, 6 to 10 digits in all. 3926.90, 3926 90 97 and 3926.90.9985 pass.
--    src/lib/hs-codes.ts isValidHsCode applies the same rule in the app. The
--    table held no rows when this was written, so neither CHECK can fail on
--    existing data.
--  - product_hs_codes.leg loses its '*' default, because '*' no longer passes
--    the leg CHECK. Every write names its leg.
--  - hub_issue_commercial_invoice and hub_replace_commercial_invoice_lines: the
--    only way the app issues a draft or replaces a draft's lines. Both take the
--    invoice row FOR UPDATE first, so an edit and an issue of the same draft run
--    one after the other. Without the lock, an edit could read the draft, the
--    issue could check its HS codes and flip it to issued, and the edit would
--    then rewrite the lines of an issued invoice. Each re-checks status draft
--    under the lock. SECURITY DEFINER with a pinned search_path, execute for
--    service_role only; the server actions call them after their own checks.
--
-- Grants change only for those two functions. product_hs_codes still has no
-- write policy: the HS codes screen writes through the service-role client
-- after checking invoice.create.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

insert into public.entities (code, legal_name, address_lines, vat_tax_id, eori, default_currency)
values ('EB-CANADA', 'Echo Barrier Canada, Inc', array['Confirm registered address'], null, null, 'CAD')
on conflict (code) do nothing;

-- Cost-level placeholders pending Dave and Juraj, exactly like the USA leg.
insert into public.intercompany_prices (sku, leg, unit_value, currency, active)
select p.sku, 'GROUP_TO_CANADA', p.unit_value, p.currency, p.active
from public.intercompany_prices p
where p.leg = 'GROUP_TO_USA'
  and exists (
    select 1
    from public.po_product_catalog c
    join public.product_code_master m on m.internal_sku = c.internal_sku
    where c.sku = p.sku
      and m.code_canada is not null
  )
on conflict (sku, leg) do nothing;

insert into public.invoice_composition_rules (active, country, leg, rule_type, source_sku, config, note, priority)
select r.active, r.country, 'GROUP_TO_CANADA', r.rule_type, r.source_sku, r.config,
       'Mirrors the Group to USA rule for Group to Canada. CONFIRM it applies to Canada.',
       r.priority
from public.invoice_composition_rules r
where r.leg = 'GROUP_TO_USA'
  and not exists (
    select 1 from public.invoice_composition_rules c
    where c.leg = 'GROUP_TO_CANADA'
      and c.rule_type = r.rule_type
      and c.source_sku = r.source_sku
      and c.country is not distinct from r.country
  );

alter table public.product_hs_codes alter column leg drop default;

alter table public.product_hs_codes
  add constraint product_hs_codes_leg_check
  check (leg in ('SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'));

alter table public.product_hs_codes
  add constraint product_hs_codes_hs_code_format
  check (
    hs_code is null
    or (
      hs_code ~ '^[0-9]+([. ][0-9]+)*$'
      and length(regexp_replace(hs_code, '[^0-9]', '', 'g')) between 6 and 10
    )
  );

-- Issue a draft, atomically. Refuses (and changes nothing) when the invoice is
-- missing, is not a draft, has no lines, or has any line whose hs_code is null
-- or blank. A refusal for missing codes returns the SKUs, and every line in
-- order, so the app can name the products and say where each code comes from.
create or replace function public.hub_issue_commercial_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_missing jsonb;
begin
  select ci.status into v_status
  from public.commercial_invoices ci
  where ci.id = p_invoice_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'not_draft', 'status', v_status);
  end if;
  if not exists (select 1 from public.commercial_invoice_lines l where l.invoice_id = p_invoice_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_lines');
  end if;

  select coalesce(jsonb_agg(l.sku order by l.sort_order), '[]'::jsonb) into v_missing
  from public.commercial_invoice_lines l
  where l.invoice_id = p_invoice_id
    and (l.hs_code is null or l.hs_code !~ '[^[:space:]]');

  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'missing_hs_codes',
      'missing_skus', v_missing,
      'lines', (
        select jsonb_agg(jsonb_build_object('sku', l.sku, 'product_name', l.product_name, 'hs_code', l.hs_code) order by l.sort_order)
        from public.commercial_invoice_lines l
        where l.invoice_id = p_invoice_id
      )
    );
  end if;

  update public.commercial_invoices
  set status = 'issued'
  where id = p_invoice_id;

  return jsonb_build_object('ok', true, 'status', 'issued');
end;
$$;

revoke all on function public.hub_issue_commercial_invoice(uuid) from public, anon, authenticated;
grant execute on function public.hub_issue_commercial_invoice(uuid) to service_role;

-- Replace a draft's lines and its totals, atomically. p_lines is the reconciled
-- line set (sku, product_name, qty, unit_value, line_total, hs_code,
-- sort_order); p_header carries subtotal and total. The lines take the
-- container_ref of the locked invoice row, never one from the payload. Returns
-- the lines as they were before, read under the lock, for the edit log.
create or replace function public.hub_replace_commercial_invoice_lines(p_invoice_id uuid, p_lines jsonb, p_header jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_container text;
  v_before jsonb;
begin
  select ci.status, ci.container_ref into v_status, v_container
  from public.commercial_invoices ci
  where ci.id = p_invoice_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'not_draft', 'status', v_status);
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_lines');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sku', l.sku, 'product_name', l.product_name, 'qty', l.qty, 'unit_value', l.unit_value,
        'line_total', l.line_total, 'hs_code', l.hs_code, 'sort_order', l.sort_order
      )
      order by l.sort_order
    ),
    '[]'::jsonb
  ) into v_before
  from public.commercial_invoice_lines l
  where l.invoice_id = p_invoice_id;

  delete from public.commercial_invoice_lines where invoice_id = p_invoice_id;

  insert into public.commercial_invoice_lines
    (invoice_id, sku, product_name, qty, unit_value, line_total, hs_code, container_ref, sort_order)
  select
    p_invoice_id, l->>'sku', l->>'product_name', (l->>'qty')::numeric, (l->>'unit_value')::numeric,
    (l->>'line_total')::numeric, l->>'hs_code', v_container, coalesce((l->>'sort_order')::int, 0)
  from jsonb_array_elements(p_lines) as l;

  update public.commercial_invoices
  set subtotal = (p_header->>'subtotal')::numeric,
      total = (p_header->>'total')::numeric,
      updated_at = now()
  where id = p_invoice_id;

  return jsonb_build_object('ok', true, 'before', v_before);
end;
$$;

revoke all on function public.hub_replace_commercial_invoice_lines(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.hub_replace_commercial_invoice_lines(uuid, jsonb, jsonb) to service_role;
