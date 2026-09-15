-- Organisations: the seven Xero companies as the Hub's outer scope.
--
-- Dean, 15 Sep 2026: "a dropdown under each section especially for the admin
-- and the other users will only be able to see their own dropdown ... USA,
-- CANADA, FRANCE, SRO, GROUP, AUSTRALIA, UK etc all the organisations we have
-- in Xero atm ... Jillian can only see USA Claire only France but Dave all of
-- them."
--
-- Before this the Hub scoped rows by one column, profiles.pipeline_id, and
-- only Quotes and Calls used it. The registry of companies already existed as
-- public.entities but held four of the seven and no Xero tenant ids. This
-- migration:
--
--  1. grows entities into the full registry;
--  2. adds user_organisations, a grant table shaped exactly like
--     user_capabilities: a row per person per organisation, readable by its
--     owner and by super admins, written by the service role only;
--  3. gives customer_invoices an organisation_code, because the stage queues
--     read that table directly and it carried no region column at all;
--  4. teaches create_customer_invoice to write it.
--
-- Grants are NOT seeded here. Like capabilities, a grant is a deliberate act:
-- a row per person, applied by hand, and a public repository is no place for
-- the list of who holds what. Super admins need no rows.
--
-- The code-side registry and every module's mapping onto it live in
-- src/lib/organisations.ts; tests/unit/organisations-migration.test.ts keeps
-- the two in step.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

-- ---------------------------------------------------------------------------
-- 1. The registry
-- ---------------------------------------------------------------------------
-- Legal names as Xero reports them, except France, whose registered name has
-- not been read back yet: the row carries the trading name so the code can
-- exist, and the name is corrected when the Xero organisation is read.
-- Addresses are placeholders in the same shape the Canada row already uses.
insert into public.entities (code, legal_name, address_lines, vat_tax_id, eori, default_currency)
values
  ('EB-FRANCE', 'Echo Barrier France', array['Confirm registered address'], null, null, 'EUR'),
  ('EB-AUSTRALIA', 'Echo Barrier Australia Pty Ltd', array['Confirm registered address'], null, null, 'AUD'),
  ('EB-UK', 'Echo Barrier Limited', array['Confirm registered address'], null, null, 'GBP')
on conflict (code) do nothing;

-- Tenant ids are organisation identifiers, not secrets: the same ids sit in
-- the n8n Xero workflows. Only filled where nothing is recorded yet, so a
-- value set by hand is never overwritten. France's tenant id is not recorded
-- anywhere the Hub can read and is left for the same by-hand update.
update public.entities e
set xero_tenant_id = v.tenant_id
from (values
  ('EB-USA', '4a845dad-c15a-4f6d-a417-c4286e02b3ea'),
  ('EB-CANADA', '507849b0-ed7d-4959-b691-eb2f906818f0'),
  ('EB-GROUP', 'c4174bdc-748e-4fc8-a9b0-876de39f57bd'),
  ('EB-SRO', '5ea514e0-1ac4-4941-bc5b-d2f4b43a0e8f'),
  ('EB-AUSTRALIA', '07e5db05-2d9c-428f-804e-ae9b32266f97'),
  ('EB-UK', '375c1eef-53c7-4ae8-80cc-b099454903e5')
) as v(code, tenant_id)
where e.code = v.code
  and e.xero_tenant_id is null;

-- ---------------------------------------------------------------------------
-- 2. Who holds which organisation
-- ---------------------------------------------------------------------------
create table public.user_organisations (
  user_id      uuid not null references auth.users(id) on delete cascade,
  organisation text not null references public.entities(code),
  granted_at   timestamptz not null default now(),
  granted_by   uuid references auth.users(id) on delete set null,
  primary key (user_id, organisation)
);

create index user_organisations_user_id_idx on public.user_organisations (user_id);

alter table public.user_organisations enable row level security;

-- Every grant goes rather than being narrowed, because RLS does not restrain
-- TRUNCATE and this project grants authenticated TRUNCATE on every new public
-- table. Then exactly the one thing a signed-in user needs: reading rows.
revoke all on public.user_organisations from public, anon, authenticated;
grant select on public.user_organisations to authenticated;

create policy "Users read own organisations"
  on public.user_organisations for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_super_admin()));

-- ---------------------------------------------------------------------------
-- 3. Which organisation a customer invoice belongs to
-- ---------------------------------------------------------------------------
-- Added nullable, filled, then made required. Every invoice raised so far is a
-- US-depot USD invoice (verified on 15 Sep 2026: all 16 rows), so the backfill
-- is a statement of fact, not a guess. No default afterwards: a new row has to
-- say which organisation it belongs to.
alter table public.customer_invoices
  add column organisation_code text references public.entities(code);

update public.customer_invoices
set organisation_code = 'EB-USA'
where organisation_code is null;

alter table public.customer_invoices
  alter column organisation_code set not null;

create index customer_invoices_organisation_status_idx
  on public.customer_invoices (organisation_code, status);

-- ---------------------------------------------------------------------------
-- 4. create_customer_invoice writes it
-- ---------------------------------------------------------------------------
-- The function lists its columns by name, so the new one has to be named here
-- too. Identical to the previous body apart from organisation_code; the
-- header key is required, which is what makes the not-null column bite in
-- the right place (the action) rather than deep in the database.
create or replace function public.create_customer_invoice(p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reference text;
  v_id uuid;
begin
  -- A DRAFT reference only. Gaps here are harmless, which is exactly why the
  -- customer-facing EBUS number is NOT minted from a sequence: see
  -- raise_customer_invoice.
  v_reference := 'USI' || to_char(now(), 'YYYY') || '-' ||
                 lpad(nextval('public.customer_invoice_seq')::text, 5, '0');

  insert into public.customer_invoices (
    hubspot_deal_id, holding_reference, organisation_code, currency, invoice_date, due_date,
    hubspot_company_id, company_name, taxjar_customer_id, customer_po_number,
    delivery_street, delivery_city, delivery_state, delivery_zip, delivery_country,
    is_collection,
    subtotal, shipping_total, source_lines_snapshot, lines_hash, created_by_uid, updated_by_uid
  ) values (
    p_header->>'hubspot_deal_id',
    v_reference,
    p_header->>'organisation_code',
    coalesce(p_header->>'currency', 'USD'),
    (p_header->>'invoice_date')::date,
    (p_header->>'due_date')::date,
    p_header->>'hubspot_company_id',
    p_header->>'company_name',
    nullif(btrim(p_header->>'taxjar_customer_id'), ''),
    p_header->>'customer_po_number',
    nullif(btrim(p_header->>'delivery_street'), ''),
    nullif(btrim(p_header->>'delivery_city'), ''),
    nullif(btrim(upper(p_header->>'delivery_state')), ''),
    nullif(btrim(p_header->>'delivery_zip'), ''),
    coalesce(p_header->>'delivery_country', 'US'),
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
            'holding_reference', v_reference,
            'is_collection', coalesce((p_header->>'is_collection')::boolean, false)
          ));

  return jsonb_build_object('id', v_id, 'holding_reference', v_reference);
end;
$function$;
