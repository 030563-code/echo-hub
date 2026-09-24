-- A Canadian customer invoice can exist.
--
-- Phase 1 of Canadian invoicing in the Hub. Dean, 17 Sep 2026: a Canadian rep
-- raises an invoice through the same screens as the USA, with Xero working out
-- the tax where TaxJar stands. This migration makes a Canadian row STORABLE and
-- nothing more. It raises no invoice and posts nothing anywhere; the Hub itself
-- refuses the Canadian tax step until that step exists.
--
-- The same shape as 20260922230000_a_french_customer_invoice_can_exist. Each
-- constraint is REPLACED, with its US and French branches copied byte for byte
-- from that migration, so nothing about the live USA or France paths can drift,
-- and a Canadian branch is added beside them.
--
-- NOT touched: raise_customer_invoice. Its live body has numbered EB-CANADA in
-- the EBCA series since 20260922230000 (read with pg_get_functiondef on 24 Sep
-- 2026), and rewriting a function the USA numbers every invoice through, only to
-- produce the same text, is risk for nothing. The proof at the end fails this
-- migration if that branch has gone.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. A Canadian address can be stored.
-- ---------------------------------------------------------------------------

alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_country_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_country_ck
  check (delivery_country in ('US', 'FR', 'CA'));

-- A Canadian row carries a province or territory, as Canada Post codes them.
-- 🔴 'CA' is California's code, and it is refused on a Canadian row: it is the
-- likeliest wrong answer in that field, since it is also Canada's country code.
alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_state_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_state_ck
  check (
    case delivery_country
      when 'US' then delivery_state is null or delivery_state = any (array[
        'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
        'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
        'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'])
      when 'CA' then delivery_state is null or delivery_state = any (array[
        'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'])
      else delivery_state is null
    end
  );

-- The Canadian postal code in the one form the Hub stores, capitals and one
-- space, with Canada Post's excluded letters: D F I O Q U never, W and Z never
-- first. The same pattern as CA_POSTAL_CODE_PATTERN in src/lib/ca-address.ts.
-- Without this branch the old ELSE refused any postcode at all on a Canadian row.
alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_zip_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_zip_ck
  check (
    case delivery_country
      when 'US' then delivery_zip is null or delivery_zip ~ '^[0-9]{5}(-[0-9]{4})?$'
      when 'FR' then delivery_zip is null or delivery_zip ~ '^[0-9]{5}$'
      when 'CA' then delivery_zip is null or delivery_zip ~ '^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z] [0-9][ABCEGHJ-NPRSTV-Z][0-9]$'
      else delivery_zip is null
    end
  );

-- ---------------------------------------------------------------------------
-- 2. Goods can ship from Hamilton.
-- ---------------------------------------------------------------------------
-- Including a Canadian deal's fitting kit: split_fitting_kit_lines() keeps a
-- non-US deal's hooks and bungees at the deal's own depot.

alter table public.customer_invoice_lines
  drop constraint if exists customer_invoice_lines_ship_from_depot_check;
alter table public.customer_invoice_lines
  add constraint customer_invoice_lines_ship_from_depot_check
  check (ship_from_depot = any (array['US-BAL', 'US-SBD', 'EU-FR', 'CA-HAM']));

-- ---------------------------------------------------------------------------
-- 3. The EBCA series, visible before its first invoice.
-- ---------------------------------------------------------------------------
-- allocate_document_number would create this row on first use anyway, starting
-- at 1, so seeding it burns nothing and changes no number. It is made now so the
-- series can be seen, and changed, before any Canadian invoice takes a number:
-- EBCA26-0001 is the first one this allocates.

insert into public.invoice_number_counters (series, year_suffix, next_value)
values ('EBCA', to_char(now() at time zone 'utc', 'YY'), 1)
on conflict (series, year_suffix) do nothing;

-- ---------------------------------------------------------------------------
-- Proof. A Canadian row is actually inserted, and each trap actually refused,
-- inside blocks that roll themselves back, so nothing is left behind.
-- ---------------------------------------------------------------------------
do $proof$
declare
  fn text := pg_get_functiondef('public.raise_customer_invoice(uuid,text,uuid)'::regprocedure);
  v_id uuid;
begin
  if position('when ''EB-CANADA'' then ''EBCA''' in fn) = 0 then
    raise exception 'raise_customer_invoice no longer numbers EB-CANADA in the EBCA series';
  end if;
  if position('when ''EB-USA'' then ''EBUS''' in fn) = 0 or position('when ''EB-FRANCE'' then ''EBFR''' in fn) = 0 then
    raise exception 'raise_customer_invoice no longer numbers the USA in EBUS and France in EBFR';
  end if;
  if not exists (select 1 from public.invoice_number_counters where series = 'EBCA') then
    raise exception 'the EBCA series was not added';
  end if;

  -- A Canadian invoice and a Hamilton line fit.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_ca__', '__probe_ca__', 'draft', 'CAD', 'EB-CANADA', 'CA', 'ON', 'M9X 9Z9')
    returning id into v_id;
    insert into public.customer_invoice_lines (invoice_id, line_key, name, quantity, line_total, ship_from_depot)
    values (v_id, 'L1', 'probe', 1, 0, 'CA-HAM');
    raise exception 'PROBE_ROLLBACK';
  exception
    when raise_exception then
      if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;

  -- California's code on a Canadian row.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_ca2__', '__probe_ca2__', 'draft', 'CAD', 'EB-CANADA', 'CA', 'CA', 'M9X 9Z9');
    raise exception 'a Canadian row was allowed the state CA';
  exception
    when check_violation then null;
  end;

  -- A postal code without its space, which the Hub never stores.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_ca3__', '__probe_ca3__', 'draft', 'CAD', 'EB-CANADA', 'CA', 'ON', 'M9X9Z9');
    raise exception 'a Canadian row was allowed an unspaced postal code';
  exception
    when check_violation then null;
  end;

  -- A letter Canada Post never uses (O, typed for a zero).
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_ca4__', '__probe_ca4__', 'draft', 'CAD', 'EB-CANADA', 'CA', 'ON', 'M9O 9Z9');
    raise exception 'a Canadian row was allowed the letter O in its postal code';
  exception
    when check_violation then null;
  end;

  -- A US zip on a Canadian row.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_ca5__', '__probe_ca5__', 'draft', 'CAD', 'EB-CANADA', 'CA', 'ON', '20794');
    raise exception 'a Canadian row was allowed a US zip';
  exception
    when check_violation then null;
  end;

  -- A Canadian province on a US row: the US branch is unchanged.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_us__', '__probe_us__', 'draft', 'USD', 'EB-USA', 'US', 'ON', '20794');
    raise exception 'a US row was allowed a Canadian province';
  exception
    when check_violation then null;
  end;

  -- A country nobody invoices in.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe_xx__', '__probe_xx__', 'draft', 'CAD', 'EB-CANADA', 'XX', null, null);
    raise exception 'a row was allowed the country XX';
  exception
    when check_violation then null;
  end;

  -- A depot nobody invoices from.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country)
    values ('__probe_ca6__', '__probe_ca6__', 'draft', 'CAD', 'EB-CANADA', 'CA')
    returning id into v_id;
    insert into public.customer_invoice_lines (invoice_id, line_key, name, quantity, line_total, ship_from_depot)
    values (v_id, 'L1', 'probe', 1, 0, 'CA-XYZ');
    raise exception 'a line was allowed to ship from CA-XYZ';
  exception
    when check_violation then null;
  end;

  if exists (select 1 from public.customer_invoices where hubspot_deal_id like '\_\_probe%') then
    raise exception 'a probe row survived';
  end if;
end $proof$;
