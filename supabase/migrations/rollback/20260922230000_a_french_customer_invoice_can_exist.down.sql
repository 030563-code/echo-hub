-- Undo 20260922230000_a_french_customer_invoice_can_exist.
--
-- 🔴 THIS REFUSES TO RUN IF A FRENCH INVOICE EXISTS. Narrowing the constraints
-- back to the United States would either fail on those rows or, worse, succeed
-- because somebody added NOT VALID. A French invoice that has been raised has a
-- gapless number against it and may be in Xero; it is not rollback material.
-- Delete it deliberately first, or do not roll back.
--
-- The TVA number is left in place on purpose. It was read from Xero, it is true,
-- and removing a correct fact is not an undo.

do $$
declare
  n int;
begin
  select count(*) into n from public.customer_invoices where organisation_code <> 'EB-USA';
  if n > 0 then
    raise exception '% non-USA customer invoice(s) exist. Deal with them before narrowing the constraints back to the United States.', n;
  end if;

  select count(*) into n from public.customer_invoice_lines where ship_from_depot = 'EU-FR';
  if n > 0 then
    raise exception '% invoice line(s) ship from EU-FR. Deal with them before narrowing the depot list.', n;
  end if;
end $$;

alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_country_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_country_ck
  check (delivery_country = 'US');

alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_state_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_state_ck
  check (delivery_state is null or delivery_state = any (array[
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
    'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
    'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']));

alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_zip_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_zip_ck
  check (delivery_zip is null or delivery_zip ~ '^[0-9]{5}(-[0-9]{4})?$');

alter table public.customer_invoice_lines
  drop constraint if exists customer_invoice_lines_ship_from_depot_check;
alter table public.customer_invoice_lines
  add constraint customer_invoice_lines_ship_from_depot_check
  check (ship_from_depot = any (array['US-BAL', 'US-SBD']));

-- The series branch goes back to the single hardcoded literal.
create or replace function public.raise_customer_invoice(p_invoice_id uuid, p_expected_hash text, p_actor uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_status text;
  v_hash text;
  v_existing text;
  v_number text;
  v_year text;
begin
  select status, lines_hash, invoice_number
  into v_status, v_hash, v_existing
  from public.customer_invoices
  where id = p_invoice_id
  for update;

  if v_status is null then
    raise exception 'INVOICE_NOT_FOUND';
  end if;

  if v_existing is not null then
    return jsonb_build_object('invoice_number', v_existing, 'already_raised', true);
  end if;

  if v_status not in ('tax_calculated', 'authorizing') then
    raise exception 'INVALID_STATUS:%', v_status;
  end if;
  if v_hash is distinct from p_expected_hash then
    raise exception 'STALE_CALCULATION';
  end if;

  v_year := to_char(now() at time zone 'utc', 'YY');
  v_number := public.allocate_document_number('EBUS', v_year);

  update public.customer_invoices
  set invoice_number = v_number,
      raised_at = now(),
      updated_by_uid = p_actor,
      updated_at = now()
  where id = p_invoice_id;

  insert into public.customer_invoice_events (invoice_id, event, actor_uid, payload)
  values (p_invoice_id, 'raised', p_actor, jsonb_build_object('invoice_number', v_number));

  return jsonb_build_object('invoice_number', v_number, 'already_raised', false);
end;
$function$;

-- The two added columns go, but only when nothing is stored in them.
do $$
declare
  n int;
begin
  select count(*) into n from public.customer_invoices where xero_draft_invoice_id is not null;
  if n > 0 then
    raise exception '% invoice(s) hold a Xero draft id. Those drafts exist in Xero; resolve them before dropping the column.', n;
  end if;
  select count(*) into n from public.account_registry where france_xero_account_code is not null;
  if n > 0 then
    raise exception '% companies carry a France Xero account code. Dropping the column would throw away real mappings.', n;
  end if;
end $$;

alter table public.customer_invoices drop column if exists xero_draft_invoice_id;
alter table public.account_registry drop column if exists france_xero_account_code;

do $$
begin
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'customer_invoices_delivery_country_ck')
     not like '%= ''US''%' then
    raise exception 'the country constraint was not narrowed back to the United States';
  end if;
  if position('EB-FRANCE' in (select pg_get_functiondef(oid) from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'raise_customer_invoice')) > 0 then
    raise exception 'the France series branch survived the rollback';
  end if;
end $$;
