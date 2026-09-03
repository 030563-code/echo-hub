-- Quotes Hub Phase B: customer pricing, rep discount caps, and the HubSpot
-- quote ledger. Target project korylyniwsqtsvzuzydg ("Hubspot Shipping and
-- Stocks"). Design: ~/.claude/plans (Phase B plan, 2026-09-02).
--
-- NOT YET APPLIED. Lives in migrations/pending/ so migrations/ stays a mirror
-- of live. Apply via MCP apply_migration, then MOVE this file into
-- migrations/. Never `db push`.
--
-- Additive only: six new tables, two capability catalogue rows. It does not
-- touch deals_registry. That is deliberate: deals_registry carries an
-- unconditional AFTER trigger that POSTs every touched row to n8n and a BEFORE
-- trigger that rewrites line_items_raw, so an UPDATE here could re-fire the
-- accepted-quote pipeline and duplicate Xero quotes.
--
-- WHY THIS EXISTS. The HubSpot product catalogue carries placeholder prices
-- (every USA SKU is 1.00, verified live 2026-09-02), so reps type the real
-- price from memory on every quote with no floor and no limit. Dave asked to
-- own general pricing and contractor contract pricing, and to set how much
-- each rep may discount. Jillian gets the same list read-only.

-- ---------------------------------------------------------------------------
-- Contractors: the customer companies that hold a negotiated price list with
-- us (United Rentals, HERMEQ). Keyed by the HubSpot company id so a deal's own
-- associated company resolves a contract price with no name matching.
-- ---------------------------------------------------------------------------
create table public.contractors (
  hubspot_company_id text primary key,
  name               text not null,
  domain             text,
  is_active          boolean not null default true,
  notes              text,
  updated_by_uid     uuid,
  updated_by_label   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- General list prices, per SKU per currency. floor_price is the lowest net
-- unit price a rep may reach by discounting; null means no floor.
-- ---------------------------------------------------------------------------
create table public.list_prices (
  id               uuid primary key default gen_random_uuid(),
  sku              text not null,
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  product_name     text,
  hs_product_id    text,
  unit_price       numeric(12,2) not null check (unit_price >= 0),
  floor_price      numeric(12,2) check (floor_price is null or (floor_price >= 0 and floor_price <= unit_price)),
  is_active        boolean not null default true,
  updated_by_uid   uuid,
  updated_by_label text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (sku, currency)
);

-- ---------------------------------------------------------------------------
-- Contract prices beat list prices for one company. valid_from / valid_to are
-- optional bounds, either side open. Several dated rows may exist for the same
-- SKU; the app takes the one in force today with the latest valid_from.
-- ---------------------------------------------------------------------------
create table public.contract_prices (
  id                 uuid primary key default gen_random_uuid(),
  hubspot_company_id text not null references public.contractors(hubspot_company_id) on delete cascade,
  sku                text not null,
  currency           text not null check (currency ~ '^[A-Z]{3}$'),
  unit_price         numeric(12,2) not null check (unit_price >= 0),
  valid_from         date,
  valid_to           date,
  notes              text,
  is_active          boolean not null default true,
  updated_by_uid     uuid,
  updated_by_label   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (valid_from is null or valid_to is null or valid_to >= valid_from),
  unique nulls not distinct (hubspot_company_id, sku, currency, valid_from)
);

create index contract_prices_lookup_idx
  on public.contract_prices (hubspot_company_id, currency) where is_active;

-- ---------------------------------------------------------------------------
-- How far each rep may discount. BOTH columns are nullable and every cap that
-- is set must hold. NO ROW AT ALL means no discount, which is why this table
-- is not backfilled: a rep gets discount authority only when Dave grants it.
-- ---------------------------------------------------------------------------
create table public.rep_discount_caps (
  user_id               uuid primary key references public.profiles(id) on delete cascade,
  max_discount_pct      numeric(5,2) check (max_discount_pct is null or (max_discount_pct >= 0 and max_discount_pct <= 100)),
  max_discount_per_unit numeric(12,2) check (max_discount_per_unit is null or max_discount_per_unit >= 0),
  updated_by_uid        uuid,
  updated_by_label      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Append-only price history. A spreadsheet cannot keep this, which was the
-- stated reason for moving pricing into the Hub at all. Written best-effort by
-- the save actions (bom_edit_log precedent): a failed log never fails an edit.
-- ---------------------------------------------------------------------------
create table public.pricing_change_log (
  id               bigint generated always as identity primary key,
  table_name       text not null,
  row_key          text not null,
  before           jsonb,
  after            jsonb,
  changed_by_uid   uuid,
  changed_by_label text,
  created_at       timestamptz not null default now()
);

create index pricing_change_log_row_idx
  on public.pricing_change_log (table_name, row_key, created_at desc);

-- ---------------------------------------------------------------------------
-- The HubSpot quotes the Hub has created for a deal. The row is inserted BEFORE
-- the first HubSpot write and updated at every step, so a generate that dies
-- part way is resumable: hubspot_quote_id null means the quote itself was never
-- created, an empty hs_line_item_ids means the lines were not, and anything
-- later is safe to repeat. failed_step records where it stopped.
--
-- Several quotes per deal are expected and allowed. Reps already keep variants
-- in HubSpot, so nothing here voids an earlier one.
--
-- amount is the Hub's own computed total, hub_amount aside; both are kept so a
-- cent-level disagreement with HubSpot's calculation is visible rather than
-- silently accepted.
-- ---------------------------------------------------------------------------
create table public.deal_quotes (
  id                uuid primary key default gen_random_uuid(),
  hubspot_deal_id   text not null,
  hubspot_quote_id  text unique,            -- null until HubSpot's create returns
  hs_line_item_ids  text[] not null default '{}',
  quote_number      text,
  title             text,
  status            text not null check (status in ('draft','published','failed')),
  failed_step       text,                   -- create_quote | create_line_items | associate | publish | read_back
  error_message     text,
  quote_link        text,
  pdf_link          text,
  amount            numeric(12,2),          -- HubSpot's own hs_quote_amount
  hub_amount        numeric(12,2),          -- what the Hub computed
  currency          text,
  template_key      text,                   -- 'US' | 'CAN', the profile's own value
  template_id       text,
  expires_on        date,
  comments          text,
  contact_id        text,
  company_id        text,
  line_items        jsonb not null default '[]'::jsonb,
  email_composed_at timestamptz,
  created_by_uid    uuid,
  created_by_label  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index deal_quotes_deal_idx on public.deal_quotes (hubspot_deal_id, created_at desc);

-- One in-flight generate per deal. The builder's own submit guard is client
-- state and does not survive a refresh; this does. A second concurrent Generate
-- hits this and is told to use Retry rather than minting a second quote.
create unique index deal_quotes_one_in_flight
  on public.deal_quotes (hubspot_deal_id) where status = 'draft';

-- ---------------------------------------------------------------------------
-- Lockdown doctrine (customer_invoices precedent): RLS on, revoke everything
-- from anon and authenticated, then grant SELECT back only where a session
-- genuinely reads. Every write goes through a server action that has already
-- checked a capability, on the service-role client.
-- ---------------------------------------------------------------------------
alter table public.contractors        enable row level security;
alter table public.list_prices        enable row level security;
alter table public.contract_prices    enable row level security;
alter table public.rep_discount_caps  enable row level security;
alter table public.pricing_change_log enable row level security;
alter table public.deal_quotes        enable row level security;

revoke all on public.contractors, public.list_prices, public.contract_prices,
              public.rep_discount_caps, public.pricing_change_log, public.deal_quotes
  from public, anon, authenticated;

-- Prices are readable by anyone who can quote, not only by the pricing module.
-- A rep must be able to build a quote at list price without being granted
-- pricing.view, otherwise the quote builder breaks for everyone on day one.
grant select on public.contractors, public.list_prices, public.contract_prices to authenticated;

create policy "hub: read list prices" on public.list_prices
  for select to authenticated
  using (
    (select public.has_capability('quotes.view'))
    or (select public.has_capability('quotes.create'))
    or (select public.has_capability('pricing.view'))
    or (select public.has_capability('pricing.manage'))
  );

create policy "hub: read contract prices" on public.contract_prices
  for select to authenticated
  using (
    (select public.has_capability('quotes.view'))
    or (select public.has_capability('quotes.create'))
    or (select public.has_capability('pricing.view'))
    or (select public.has_capability('pricing.manage'))
  );

create policy "hub: read contractors" on public.contractors
  for select to authenticated
  using (
    (select public.has_capability('quotes.view'))
    or (select public.has_capability('quotes.create'))
    or (select public.has_capability('pricing.view'))
    or (select public.has_capability('pricing.manage'))
  );

-- A rep sees their OWN cap (the builder shows it under the cart). Only the
-- pricing admin sees everyone's.
grant select on public.rep_discount_caps to authenticated;
create policy "hub: read own discount cap" on public.rep_discount_caps
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.has_capability('pricing.manage'))
  );

grant select on public.pricing_change_log to authenticated;
create policy "hub: read pricing history" on public.pricing_change_log
  for select to authenticated
  using ((select public.has_capability('pricing.manage')));

-- deal_quotes gets NO grant and NO policy: RLS on with nothing granted means
-- service role only, which is how customer_invoices is read. The deal page and
-- the builder read it in server code that has already run assertDealAccess, so
-- a second RLS expression here would only be a second thing to keep in step.

insert into public.capabilities (key, module, description) values
  ('pricing.view',   'pricing', 'See list prices, contract prices and own discount cap'),
  ('pricing.manage', 'pricing', 'Edit list prices, contractors, contract prices and rep discount caps')
on conflict (key) do nothing;

comment on table public.list_prices is
  'General price list per SKU and currency. Beats the HubSpot product catalogue, which carries placeholder prices. floor_price is the lowest net unit price a discount may reach.';
comment on table public.contract_prices is
  'Negotiated per-customer prices. Beat list prices for that company when in force today.';
comment on table public.rep_discount_caps is
  'Per-rep discount authority. No row means no discount. Both columns nullable; every cap that is set must hold.';
comment on table public.deal_quotes is
  'HubSpot Quote objects the Hub created. status draft is written before the publish PATCH so a crash is recoverable.';
