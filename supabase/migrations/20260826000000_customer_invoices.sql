-- US customer invoicing: accepted US quotes reviewed in the Hub, taxed via TaxJar,
-- authorized into Xero through n8n. Design: docs/us-invoicing.md (TaxJar build).
-- APPLIED LIVE via MCP apply_migration (customer_invoices) on korylyniwsqtsvzuzydg.
-- This file is the repo mirror. Never `db push`.
-- Additive only: three new service-role-only tables, one RPC, one sequence,
-- nullable delivery columns on deals_registry, two capability catalogue rows.

create sequence if not exists public.customer_invoice_seq;

create table public.customer_invoices (
  id                 uuid primary key default gen_random_uuid(),
  hubspot_deal_id    text not null,
  invoice_number     text not null unique,
  status             text not null default 'draft'
                     check (status in ('draft','tax_calculated','authorizing','authorized','sent','completed','voided')),
  currency           text not null default 'USD',
  invoice_date       date not null default (now() at time zone 'utc')::date,
  due_date           date,
  -- customer identity
  hubspot_company_id text,
  company_name       text,
  taxjar_customer_id text,
  customer_po_number text,
  -- ship-to snapshot (editable copy; deals_registry keeps the rep-entered original)
  delivery_street    text,
  delivery_city      text,
  delivery_state     text,
  delivery_zip       text,
  delivery_country   text not null default 'US',
  -- money (ex-tax except tax_total/total)
  subtotal           numeric(12,2),
  shipping_total     numeric(12,2),
  tax_total          numeric(12,2),
  total              numeric(12,2),
  -- TaxJar audit trail: jsonb arrays of {depot, request, response} per grouped call
  taxjar_request     jsonb,
  taxjar_response    jsonb,
  tax_calculated_at  timestamptz,
  lines_hash         text,
  -- source drift detection: deals_registry.line_items_raw at build time
  source_lines_snapshot jsonb,
  -- Xero leg
  idempotency_key    uuid not null default gen_random_uuid(),
  xero_invoice_id    text,
  xero_invoice_number text,
  authorized_at      timestamptz,
  emailed_at         timestamptz,
  -- TaxJar filing
  taxjar_transaction_id text,
  taxjar_transaction_recorded_at timestamptz,
  error_message      text,
  created_by_uid     uuid,
  updated_by_uid     uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One active invoice per deal; voiding frees the slot for a rebuild.
create unique index customer_invoices_active_per_deal
  on public.customer_invoices (hubspot_deal_id) where status <> 'voided';

create table public.customer_invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references public.customer_invoices(id) on delete cascade,
  line_key        text not null,
  sort_order      int  not null default 0,
  origin          text not null default 'hubspot' check (origin in ('hubspot','kit_split','manual')),
  parent_line_key text,
  hs_line_item_id text,
  hs_product_id   text,
  sku             text,
  xero_item_code  text,
  account_code    text,
  name            text not null,
  description     text,
  quantity        numeric(12,2) not null check (quantity >= 0),
  unit_price      numeric(12,2) not null default 0,
  discount_percentage numeric(5,2) not null default 0,
  line_total      numeric(12,2) not null,
  is_shipping     boolean not null default false,
  ship_from_depot text not null check (ship_from_depot in ('US-BAL','US-SBD')),
  ship_from_locked boolean not null default false,
  -- TaxJar results
  tax_amount        numeric(12,2),
  taxable_amount    numeric(12,2),
  combined_tax_rate numeric(9,6),
  tax_override      boolean not null default false,
  unique (invoice_id, line_key)
);

create table public.customer_invoice_events (
  id         bigint generated always as identity primary key,
  invoice_id uuid not null references public.customer_invoices(id) on delete cascade,
  event      text not null,
  actor_uid  uuid,
  payload    jsonb,
  created_at timestamptz not null default now()
);

-- Lockdown doctrine: RLS on with no policies; server actions use the admin client
-- after an explicit invoicing.* capability check. n8n writes on service_role.
alter table public.customer_invoices       enable row level security;
alter table public.customer_invoice_lines  enable row level security;
alter table public.customer_invoice_events enable row level security;
revoke all on public.customer_invoices, public.customer_invoice_lines,
              public.customer_invoice_events from public, anon, authenticated;

-- Atomic create: mints the internal draft reference and inserts header + lines
-- in one transaction. Service-role only.
create or replace function public.create_customer_invoice(p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number text;
  v_id uuid;
begin
  v_number := 'USI' || to_char(now(), 'YYYY') || '-' ||
              lpad(nextval('public.customer_invoice_seq')::text, 5, '0');

  insert into public.customer_invoices (
    hubspot_deal_id, invoice_number, currency, invoice_date, due_date,
    hubspot_company_id, company_name, taxjar_customer_id, customer_po_number,
    delivery_street, delivery_city, delivery_state, delivery_zip, delivery_country,
    subtotal, shipping_total, source_lines_snapshot, lines_hash, created_by_uid, updated_by_uid
  ) values (
    p_header->>'hubspot_deal_id',
    v_number,
    coalesce(p_header->>'currency', 'USD'),
    coalesce((p_header->>'invoice_date')::date, (now() at time zone 'utc')::date),
    (p_header->>'due_date')::date,
    p_header->>'hubspot_company_id',
    p_header->>'company_name',
    p_header->>'taxjar_customer_id',
    p_header->>'customer_po_number',
    p_header->>'delivery_street',
    p_header->>'delivery_city',
    p_header->>'delivery_state',
    p_header->>'delivery_zip',
    coalesce(p_header->>'delivery_country', 'US'),
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
          jsonb_build_object('invoice_number', v_number));

  return jsonb_build_object('id', v_id, 'invoice_number', v_number);
end;
$$;

revoke all on function public.create_customer_invoice(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_customer_invoice(jsonb, jsonb) to service_role;

-- Rep-entered delivery address, captured at acceptance time (shared table; additive).
alter table public.deals_registry
  add column if not exists delivery_street  text,
  add column if not exists delivery_city    text,
  add column if not exists delivery_state   text,
  add column if not exists delivery_zip     text,
  add column if not exists delivery_country text;

insert into public.capabilities (key, module, description) values
  ('invoicing.view',   'invoicing', 'View the US accepted-quotes queue and draft invoices'),
  ('invoicing.manage', 'invoicing', 'Edit drafts, calculate tax, and authorize US customer invoices')
on conflict (key) do nothing;
