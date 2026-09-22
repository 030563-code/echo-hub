-- A French customer invoice can exist.
--
-- The foundation for Claire's invoicing, and nothing more: this migration makes
-- a French row STORABLE. It opens no door in the Hub, changes no behaviour for
-- the USA, and raises no invoice. open-invoice.ts still refuses anything that is
-- not EB-USA until the France tax step exists.
--
-- Dean, 22 Sep 2026, settling the shape: the Hub posts a DRAFT to Xero, reads
-- back the tax Xero computed, and the ladder otherwise stays exactly as the USA
-- runs it, `draft -> tax_calculated -> filed -> documented -> sent -> completed`,
-- with the Xero draft standing where TaxJar stands and the authorise happening
-- last. Dave's flow is untouched.
--
-- Read live before writing this: all 25 customer_invoices rows are EB-USA and
-- organisation_code is never null, so branching on it cannot strand an existing
-- row. invoice_number_counters holds one row, EBUS/26 at 14.

-- ---------------------------------------------------------------------------
-- 1. The Xero DRAFT needs its own column. This is the load-bearing one.
-- ---------------------------------------------------------------------------
-- 🔴 It must NOT reuse xero_invoice_id. Three separate things read that column
-- as "this invoice is already in Xero, authorised, do not touch it":
-- send-to-xero.ts refuses when it is set, the n8n "Already In Xero?" branch
-- short-circuits on it, and reset-authorizing.ts uses it to decide whether a
-- stuck send actually landed. Putting the draft id there would make the France
-- authorise step unreachable and could strand a row in `authorizing` for ever.
--
-- With the draft in its own column, the authorise leg UPDATES the invoice Xero
-- already holds (PUT Status: AUTHORISED against this id) rather than creating a
-- second one. That is the whole difference between France and the USA.

alter table public.customer_invoices
  add column if not exists xero_draft_invoice_id text;

comment on column public.customer_invoices.xero_draft_invoice_id is
  'Xero InvoiceID of the DRAFT posted to price the tax. France only today. Never the authorised invoice: that is xero_invoice_id, and the authorise leg updates THIS id in place rather than creating a second Xero record.';

-- ---------------------------------------------------------------------------
-- 2. The three address CHECKs stop being United States law.
-- ---------------------------------------------------------------------------
-- Each one is REPLACED rather than dropped. The US branch is kept byte-identical
-- so nothing about the live USA path can drift, and the country now selects
-- which rules apply instead of there being only one country.

alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_country_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_country_ck
  check (delivery_country in ('US', 'FR'));

-- A state is a US concept. France must not carry one at all, rather than being
-- allowed to carry anything: an unchecked column fills up with junk.
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
      else delivery_state is null
    end
  );

-- 🔴 The old zip rule looked safe for France and was not. A French postcode is
-- five digits, so 75008 passes '^[0-9]{5}(-[0-9]{4})?$' BY ACCIDENT, and so does
-- a five digit number that is not a postcode at all. Worse, the ZIP+4 half would
-- have silently accepted 75008-1234, which is not a thing in France. Each
-- country now gets its own rule and the match is deliberate rather than lucky.
alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_zip_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_zip_ck
  check (
    case delivery_country
      when 'US' then delivery_zip is null or delivery_zip ~ '^[0-9]{5}(-[0-9]{4})?$'
      when 'FR' then delivery_zip is null or delivery_zip ~ '^[0-9]{5}$'
      else delivery_zip is null
    end
  );

-- ---------------------------------------------------------------------------
-- 3. Goods can ship from France.
-- ---------------------------------------------------------------------------
-- EU-FR is the Hub's France depot code. Note that deals_registry stores the
-- long spelling 'EU-France' for the same place; that mismatch is a separate
-- defect and is NOT papered over here. This column is written by the Hub, which
-- only ever produces the short code.

alter table public.customer_invoice_lines
  drop constraint if exists customer_invoice_lines_ship_from_depot_check;
alter table public.customer_invoice_lines
  add constraint customer_invoice_lines_ship_from_depot_check
  check (ship_from_depot = any (array['US-BAL', 'US-SBD', 'EU-FR']));

-- ---------------------------------------------------------------------------
-- 4. France gets its own gapless number series.
-- ---------------------------------------------------------------------------
-- 🔴 NEVER DEFAULT. The old body read allocate_document_number('EBUS', ...) for
-- everyone, so the first French invoice would have taken a US number and said
-- nothing. An organisation with no series now REFUSES. That is the same rule the
-- purchase order side already keeps.
--
-- No counter row is seeded: allocate_document_number creates one on first use,
-- so nothing is burned until a real French invoice is raised. The series shape
-- is EBFR26-0001, matching EBUS26-0001. Whether France instead continues
-- Claire's own EBFR2025-NN sequence is Dean's decision and is still open; until
-- the first number is allocated this is free to change, and after it is not.

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
  v_org text;
  v_series text;
begin
  select status, lines_hash, invoice_number, organisation_code
  into v_status, v_hash, v_existing, v_org
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

  v_series := case v_org
    when 'EB-USA' then 'EBUS'
    when 'EB-FRANCE' then 'EBFR'
    when 'EB-CANADA' then 'EBCA'
    else null
  end;

  if v_series is null then
    raise exception 'NO_INVOICE_SERIES:%', coalesce(v_org, '(null)');
  end if;

  v_year := to_char(now() at time zone 'utc', 'YY');
  v_number := public.allocate_document_number(v_series, v_year);

  -- Status is left alone: the caller owns the lifecycle and is mid-send. This
  -- function allocates a number and nothing else.
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

-- ---------------------------------------------------------------------------
-- 5. A French company can carry a Xero account code.
-- ---------------------------------------------------------------------------
-- account_registry held only usa_ and canada_ columns, so a French invoice had
-- nowhere to keep the code that both codes its revenue line AND finds the Xero
-- contact. send-to-xero.ts refuses outright without one.

alter table public.account_registry
  add column if not exists france_xero_account_code text;

comment on column public.account_registry.france_xero_account_code is
  'This company''s account number in Echo Barrier SAS Xero. Codes the revenue line and resolves the Xero contact for a French invoice.';

-- ---------------------------------------------------------------------------
-- 6. Echo Barrier SAS gets its TVA number, read from Xero rather than guessed.
-- ---------------------------------------------------------------------------
-- GET /Organisation on tenant 71d5024b returned TaxNumber 'FR 09978450930' on
-- 22 Sep 2026, which matches the number printed on all 27 of Claire's HubSpot
-- invoices. Stored without the space, the way her documents print it.
-- A French invoice without the issuer's TVA number is not a valid VAT invoice.
--
-- The registered address is deliberately NOT touched. It still reads the literal
-- 'Confirm registered address' and only Dean or the accountant can supply it.

update public.entities
   set vat_tax_id = 'FR09978450930'
 where code = 'EB-FRANCE'
   and vat_tax_id is null;

-- ---------------------------------------------------------------------------
-- Proof. Every claim above is asserted, and a French row is actually inserted
-- and rolled back rather than assumed to fit.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='customer_invoices'
                    and column_name='xero_draft_invoice_id') then
    raise exception 'xero_draft_invoice_id was not added';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='account_registry'
                    and column_name='france_xero_account_code') then
    raise exception 'france_xero_account_code was not added';
  end if;
  if (select vat_tax_id from public.entities where code='EB-FRANCE') is distinct from 'FR09978450930' then
    raise exception 'the France TVA number did not stick';
  end if;

  -- The USA path must be untouched: all 25 existing rows still satisfy every
  -- replaced constraint, which the ALTER would have refused otherwise. Assert
  -- the count so a silent data loss cannot hide here.
  select count(*) into n from public.customer_invoices where organisation_code = 'EB-USA';
  if n <> 25 then
    raise exception 'expected the 25 existing EB-USA invoices, found %', n;
  end if;

  -- France now fits, and junk still does not.
  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe__', '__probe__', 'draft', 'EUR', 'EB-FRANCE', 'FR', null, '75008');
  exception when others then
    raise exception 'a French row still cannot be stored: %', sqlerrm;
  end;

  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe2__', '__probe2__', 'draft', 'EUR', 'EB-FRANCE', 'FR', 'CA', '75008');
    raise exception 'a French row was allowed to carry a US state';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.customer_invoices (hubspot_deal_id, holding_reference, status, currency,
      organisation_code, delivery_country, delivery_state, delivery_zip)
    values ('__probe3__', '__probe3__', 'draft', 'EUR', 'EB-FRANCE', 'FR', null, '75008-1234');
    raise exception 'a French row was allowed a US ZIP+4 postcode';
  exception
    when check_violation then null;
  end;

  delete from public.customer_invoices where hubspot_deal_id in ('__probe__', '__probe2__', '__probe3__');

  if exists (select 1 from public.customer_invoices where hubspot_deal_id like '\_\_probe%') then
    raise exception 'a probe row survived';
  end if;
end $$;
