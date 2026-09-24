-- The landed cost of a shipment: Group's commercial invoices, and the customs and delivery costs.
--
-- Dean, 24 Sep 2026: "Dave now has some of the commercial invoices already from vladamir that
-- contain the barrier cost, palletising, delivery, insurance that he wants to put in ... He then
-- takes all the invoice barrier costs+ delivery cost +palletsing + insurance + duty + clearance
-- etc. and then divides it by the number of barriers to get the unit cost per barrier ... He
-- should also be able to manually add customs with all the neccesarry information like on his
-- sheet as a draft in the meantime while he waits for the invoices."
--
-- transport_shipment_invoice  a commercial invoice for the shipment (EBGS..., from Group), in its
--                             own currency at the rate Xero holds for the bill, with the
--                             container's palletising, delivery and insurance on it.
-- transport_shipment_line     gains the invoice each product is on and its amount there.
-- transport_shipment_cost     the customs and delivery costs typed by hand: the draft until
--                             Nippon's bill for the shipment is read, which then takes over
--                             figure by figure (src/lib/transport/landed-cost.ts).
--
-- Money is the landed cost's alone and sits behind cost.view in the Hub: the contents loader reads
-- the line columns by name and never these two (pinned in tests/unit/transport-shipment.test.ts).

create table if not exists public.transport_shipment_invoice (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.transport_shipment (id) on delete cascade,
  invoice_number text not null check (length(btrim(invoice_number)) between 1 and 40),
  invoice_date date,
  supplier text check (supplier is null or length(btrim(supplier)) between 1 and 120),
  currency text not null default 'USD' check (currency in ('USD', 'EUR', 'GBP', 'CAD')),
  -- Units of the invoice's currency to one unit of the depot's, as Xero shows the bill's rate
  -- ("1 USD = 0.85 EUR"). Null when the invoice is already in the depot's currency.
  fx_rate numeric(14, 6) check (fx_rate is null or fx_rate > 0),
  palletising numeric(14, 2) not null default 0 check (palletising >= 0),
  delivery numeric(14, 2) not null default 0 check (delivery >= 0),
  insurance numeric(14, 2) not null default 0 check (insurance >= 0),
  other_amount numeric(14, 2) not null default 0 check (other_amount >= 0),
  other_label text check (other_label is null or length(btrim(other_label)) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (shipment_id, invoice_number)
);

alter table public.transport_shipment_line
  add column if not exists invoice_id uuid references public.transport_shipment_invoice (id) on delete set null,
  -- The line's amount on its commercial invoice, in that invoice's currency.
  add column if not exists goods_amount numeric(14, 2) check (goods_amount is null or goods_amount >= 0);

create table if not exists public.transport_shipment_cost (
  shipment_id uuid primary key references public.transport_shipment (id) on delete cascade,
  -- In the depot's currency. Null is "not typed", which is not the same as nothing to pay.
  duty numeric(14, 2) check (duty is null or duty >= 0),
  mpf numeric(14, 2) check (mpf is null or mpf >= 0),
  hmf numeric(14, 2) check (hmf is null or hmf >= 0),
  -- Nippon's "duty disbursement", 3% of what CBP charged: the deferment fee on Dave's tab.
  disbursement numeric(14, 2) check (disbursement is null or disbursement >= 0),
  clearance numeric(14, 2) check (clearance is null or clearance >= 0),
  container_delivery numeric(14, 2) check (container_delivery is null or container_delivery >= 0),
  other_amount numeric(14, 2) check (other_amount is null or other_amount >= 0),
  other_label text check (other_label is null or length(btrim(other_label)) between 1 and 80),
  -- The day the landed cost was booked in Xero ("Journel Date" on the tab).
  journal_date date,
  notes text check (notes is null or length(notes) <= 2000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists transport_shipment_invoice_shipment_idx on public.transport_shipment_invoice (shipment_id);
create index if not exists transport_shipment_line_invoice_idx on public.transport_shipment_line (invoice_id);

create trigger transport_shipment_invoice_set_updated_at
  before update on public.transport_shipment_invoice
  for each row execute function public.set_updated_at();
create trigger transport_shipment_cost_set_updated_at
  before update on public.transport_shipment_cost
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Saving the invoices and what each product is on, in one go
-- ---------------------------------------------------------------------------
-- The page sends every invoice (kept ones with their id, new ones with a key of the page's own)
-- and, for every line, the key of its invoice and its amount there. One transaction: invoices
-- dropped are deleted, kept ones updated, new ones inserted, then each line pointed at its invoice.
-- A line naming an invoice that is not in the list is refused rather than quietly cleared.
create or replace function public.transport_save_landed_invoices(
  p_shipment_id uuid, p_invoices jsonb, p_lines jsonb, p_user uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  inv jsonb;
  keymap jsonb := '{}';
  kept uuid[];
  new_id uuid;
begin
  if not exists (select 1 from transport_shipment where id = p_shipment_id) then
    raise exception 'no such shipment' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_invoices) is distinct from 'array' or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'the invoices and the lines must be lists' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_invoices) i
     where nullif(i ->> 'id', '') is not null
       and not exists (select 1 from transport_shipment_invoice t where t.id = (i ->> 'id')::uuid and t.shipment_id = p_shipment_id)
  ) then
    raise exception 'an invoice does not belong to this shipment' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
     where not exists (select 1 from transport_shipment_line t where t.id = (l ->> 'id')::uuid and t.shipment_id = p_shipment_id)
  ) then
    raise exception 'a line does not belong to this shipment' using errcode = '22023';
  end if;

  select coalesce(array_agg((i ->> 'id')::uuid), '{}')
    into kept
    from jsonb_array_elements(p_invoices) i
   where nullif(i ->> 'id', '') is not null;
  delete from transport_shipment_invoice where shipment_id = p_shipment_id and not (id = any (kept));

  for inv in select value from jsonb_array_elements(p_invoices)
  loop
    if nullif(inv ->> 'id', '') is not null then
      update transport_shipment_invoice
         set invoice_number = btrim(inv ->> 'invoice_number'),
             invoice_date = nullif(inv ->> 'invoice_date', '')::date,
             supplier = nullif(btrim(coalesce(inv ->> 'supplier', '')), ''),
             currency = inv ->> 'currency',
             fx_rate = nullif(inv ->> 'fx_rate', '')::numeric,
             palletising = coalesce(nullif(inv ->> 'palletising', '')::numeric, 0),
             delivery = coalesce(nullif(inv ->> 'delivery', '')::numeric, 0),
             insurance = coalesce(nullif(inv ->> 'insurance', '')::numeric, 0),
             other_amount = coalesce(nullif(inv ->> 'other_amount', '')::numeric, 0),
             other_label = nullif(btrim(coalesce(inv ->> 'other_label', '')), ''),
             updated_by = p_user
       where id = (inv ->> 'id')::uuid;
      keymap := keymap || jsonb_build_object(inv ->> 'key', inv ->> 'id');
    else
      insert into transport_shipment_invoice
        (shipment_id, invoice_number, invoice_date, supplier, currency, fx_rate,
         palletising, delivery, insurance, other_amount, other_label, created_by, updated_by)
      values
        (p_shipment_id,
         btrim(inv ->> 'invoice_number'),
         nullif(inv ->> 'invoice_date', '')::date,
         nullif(btrim(coalesce(inv ->> 'supplier', '')), ''),
         inv ->> 'currency',
         nullif(inv ->> 'fx_rate', '')::numeric,
         coalesce(nullif(inv ->> 'palletising', '')::numeric, 0),
         coalesce(nullif(inv ->> 'delivery', '')::numeric, 0),
         coalesce(nullif(inv ->> 'insurance', '')::numeric, 0),
         coalesce(nullif(inv ->> 'other_amount', '')::numeric, 0),
         nullif(btrim(coalesce(inv ->> 'other_label', '')), ''),
         p_user,
         p_user)
      returning id into new_id;
      keymap := keymap || jsonb_build_object(inv ->> 'key', new_id::text);
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(p_lines) l
     where nullif(l ->> 'invoice_key', '') is not null and not (keymap ? (l ->> 'invoice_key'))
  ) then
    raise exception 'a line names an invoice that is not in the list' using errcode = '22023';
  end if;

  update transport_shipment_line t
     set invoice_id = case when nullif(l ->> 'invoice_key', '') is null then null else (keymap ->> (l ->> 'invoice_key'))::uuid end,
         goods_amount = nullif(l ->> 'goods_amount', '')::numeric
    from jsonb_array_elements(p_lines) l
   where t.id = (l ->> 'id')::uuid
     and t.shipment_id = p_shipment_id;

  update transport_shipment set updated_by = p_user where id = p_shipment_id;
end $$;

alter table public.transport_shipment_invoice enable row level security;
alter table public.transport_shipment_cost enable row level security;

do $$
declare t text;
begin
  foreach t in array array['transport_shipment_invoice', 'transport_shipment_cost']
  loop
    execute format('drop policy if exists "Service role full access" on public.%I', t);
    execute format(
      'create policy "Service role full access" on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

revoke all on function public.transport_save_landed_invoices(uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.transport_save_landed_invoices(uuid, jsonb, jsonb, uuid) to service_role;

comment on table public.transport_shipment_invoice is
  'Commercial invoices for a shipment (Group to the depot), for the landed cost. Service role only; the Hub checks cost.view and the depot.';
comment on table public.transport_shipment_cost is
  'Customs and delivery costs typed for a shipment, the draft until Nippon''s bill is read. Service role only.';

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['transport_shipment_invoice', 'transport_shipment_cost', 'transport_shipment_line']
  loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t and rowsecurity) then
      raise exception 'row level security is off on %', t;
    end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated')
    ) then
      raise exception 'anon or authenticated still hold grants on %', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.transport_save_landed_invoices(uuid, jsonb, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.transport_save_landed_invoices(uuid, jsonb, jsonb, uuid)', 'execute') then
    raise exception 'anon or authenticated can still run transport_save_landed_invoices';
  end if;
end $$;
