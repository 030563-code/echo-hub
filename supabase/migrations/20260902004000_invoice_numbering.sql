-- Gapless customer-facing invoice numbers, per the EBUSA order-to-invoice
-- handover (2026-09-02).
--
-- Three things this changes, all for stated reasons:
--
-- 1. The APP owns the number, not Xero. Xero assigns its own to anything you
--    post without one: a test draft consumed EB1993 from the live sequence
--    permanently, which is why that sequence skips.
-- 2. The number is GAPLESS, so a counter row incremented inside the invoice
--    transaction, never a Postgres sequence. nextval() does not roll back, so
--    every failed raise would leak a number out of a customer-facing series.
-- 3. The number is allocated when the invoice is RAISED, not at draft, or
--    every abandoned draft burns one. Drafts carry a holding reference.
--
-- APPLIED LIVE via MCP apply_migration (invoice_numbering) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.

create table if not exists public.invoice_number_counters (
  series      text not null,
  year_suffix text not null,
  next_value  integer not null default 1 check (next_value >= 1),
  updated_at  timestamptz not null default now(),
  primary key (series, year_suffix)
);

comment on table public.invoice_number_counters is
  'Gapless counters for customer-facing document numbers. EBUS = invoices, '
  'CNUS = credit notes. Incremented inside the raising transaction so a '
  'rollback returns the number, which a sequence cannot do.';

alter table public.invoice_number_counters enable row level security;
revoke all on public.invoice_number_counters from public, anon, authenticated;

-- The existing USI number becomes what it always actually was: an internal
-- holding reference for a draft. Gaps in it are harmless.
alter table public.customer_invoices rename column invoice_number to holding_reference;

-- The customer-facing number, absent until the invoice is raised.
alter table public.customer_invoices add column if not exists invoice_number text;
alter table public.customer_invoices add column if not exists raised_at timestamptz;

create unique index if not exists customer_invoices_invoice_number_key
  on public.customer_invoices (invoice_number)
  where invoice_number is not null;

-- 'raised' sits between tax_calculated and sent: the number exists and the
-- Xero draft exists, but nothing has gone to the customer yet.
alter table public.customer_invoices drop constraint if exists customer_invoices_status_check;
alter table public.customer_invoices add constraint customer_invoices_status_check
  check (status in ('draft','tax_calculated','authorizing','raised','sent','authorized','completed','voided'));

/**
 * Allocate the next number in a series. Caller MUST already be inside the
 * transaction that raises the invoice: the row lock plus that transaction is
 * the entire gapless guarantee.
 */
create or replace function public.allocate_document_number(p_series text, p_year_suffix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value integer;
begin
  insert into public.invoice_number_counters (series, year_suffix, next_value)
  values (p_series, p_year_suffix, 1)
  on conflict (series, year_suffix) do nothing;

  update public.invoice_number_counters
  set next_value = next_value + 1,
      updated_at = now()
  where series = p_series and year_suffix = p_year_suffix
  returning next_value - 1 into v_value;

  if v_value is null then
    raise exception 'COUNTER_NOT_FOUND:%-%', p_series, p_year_suffix;
  end if;

  return p_series || p_year_suffix || '-' || lpad(v_value::text, 4, '0');
end;
$$;

/**
 * Raise an invoice: allocate its customer-facing number and move it out of
 * draft, atomically. Guarded on status AND on the calculation hash, so a save
 * that landed mid-flight cannot produce a numbered invoice carrying stale tax.
 *
 * Idempotent by construction: an invoice that already has a number returns it
 * rather than allocating a second one.
 */
create or replace function public.raise_customer_invoice(
  p_invoice_id uuid,
  p_expected_hash text,
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

  -- Already raised: hand back the number rather than burning another.
  if v_existing is not null then
    return jsonb_build_object('invoice_number', v_existing, 'already_raised', true);
  end if;

  if v_status <> 'tax_calculated' then
    raise exception 'INVALID_STATUS:%', v_status;
  end if;
  if v_hash is distinct from p_expected_hash then
    raise exception 'STALE_CALCULATION';
  end if;

  v_year := to_char(now() at time zone 'utc', 'YY');
  v_number := public.allocate_document_number('EBUS', v_year);

  update public.customer_invoices
  set invoice_number = v_number,
      status = 'raised',
      raised_at = now(),
      updated_by_uid = p_actor,
      updated_at = now()
  where id = p_invoice_id;

  insert into public.customer_invoice_events (invoice_id, event, actor_uid, payload)
  values (p_invoice_id, 'raised', p_actor, jsonb_build_object('invoice_number', v_number));

  return jsonb_build_object('invoice_number', v_number, 'already_raised', false);
end;
$$;

revoke all on function public.allocate_document_number(text, text) from public, anon, authenticated;
revoke all on function public.raise_customer_invoice(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.allocate_document_number(text, text) to service_role;
grant execute on function public.raise_customer_invoice(uuid, text, uuid) to service_role;

-- Applied as a follow-up (raise_invoice_accepts_authorizing): the caller takes
-- the compare-and-set lock (tax_calculated -> authorizing) BEFORE raising, so
-- the raise has to accept the locked state, and it no longer sets status
-- itself. The CAS has already proved exclusivity; FOR UPDATE still serialises
-- the counter. See the live definition for the current body.
