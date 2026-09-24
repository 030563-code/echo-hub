-- Undo 20260924230000_a_canadian_customer_invoice_can_exist.
--
-- 🔴 THIS REFUSES TO RUN ONCE ANYTHING CANADIAN EXISTS. Narrowing the
-- constraints back would either fail on those rows or, worse, succeed because
-- somebody added NOT VALID. A Canadian invoice, a Hamilton line or an EBCA
-- number that has been taken is not rollback material: deal with it
-- deliberately first, or do not roll back.
--
-- Every constraint goes back to exactly what 20260922230000 made it, the US and
-- French branches included. raise_customer_invoice is not touched, because the
-- forward migration did not touch it: its EBCA branch predates it.

do $$
declare
  n int;
begin
  select count(*) into n from public.customer_invoices
   where organisation_code = 'EB-CANADA' or delivery_country = 'CA';
  if n > 0 then
    raise exception '% Canadian customer invoice(s) exist. Deal with them before narrowing the constraints back.', n;
  end if;

  select count(*) into n from public.customer_invoice_lines where ship_from_depot = 'CA-HAM';
  if n > 0 then
    raise exception '% invoice line(s) ship from CA-HAM. Deal with them before narrowing the depot list.', n;
  end if;

  select count(*) into n from public.invoice_number_counters where series = 'EBCA' and next_value > 1;
  if n > 0 then
    raise exception 'An EBCA invoice number has been allocated. The series is gapless and its numbers are on customer documents; it cannot simply be removed.';
  end if;
end $$;

set local lock_timeout = '3s';

alter table public.customer_invoices
  drop constraint if exists customer_invoices_delivery_country_ck;
alter table public.customer_invoices
  add constraint customer_invoices_delivery_country_ck
  check (delivery_country in ('US', 'FR'));

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

alter table public.customer_invoice_lines
  drop constraint if exists customer_invoice_lines_ship_from_depot_check;
alter table public.customer_invoice_lines
  add constraint customer_invoice_lines_ship_from_depot_check
  check (ship_from_depot = any (array['US-BAL', 'US-SBD', 'EU-FR']));

-- Only an untouched series row goes; the refusal above stops anything else.
delete from public.invoice_number_counters where series = 'EBCA' and next_value = 1;

do $$
begin
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'customer_invoices_delivery_country_ck')
     like '%''CA''%' then
    raise exception 'the country constraint still admits CA';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'customer_invoice_lines_ship_from_depot_check')
     like '%CA-HAM%' then
    raise exception 'the depot constraint still admits CA-HAM';
  end if;
  if exists (select 1 from public.invoice_number_counters where series = 'EBCA') then
    raise exception 'the EBCA series row survived the rollback';
  end if;
end $$;
