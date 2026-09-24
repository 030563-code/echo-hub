-- Shipments the Hub keeps itself, and what is on them.
--
-- Dean, 24 Sep 2026: "Dave now has some of the commercial invoices already ... since this one is
-- not on the Hub and there was no spot created for it yet and it is not done through our system he
-- has to still use the sheet. Ideally all fields would need to be editable." And: "You must also be
-- able to edit shipments to be able to add what products are on the container. for example spot
-- 244498887 doesnt have any products or pallets linked to it."
--
-- transport_shipment       the Hub's own record of a shipment. With a SPOT ID it is the Cargo Partner
--                          shipment of that number: Cargo Partner stays the authority for where it
--                          is and when, and this row only adds what Cargo Partner does not know.
--                          Without one it is a shipment kept by hand until it is booked, and every
--                          field on it is typed.
-- transport_shipment_line  what is on it: one row per product, with its quantity, its pallets and
--                          the order numbers it travels under, the way Dave's tabs have one column
--                          per barrier type.
--
-- Deliberately NOT cargo_shipment, which mirrors Cargo Partner and is rewritten on every refresh,
-- and NOT shipment_contents, from which the MRP reads stock in transit: a line typed here must not
-- move a stock figure until somebody decides it should.

create table if not exists public.transport_shipment (
  id uuid primary key default gen_random_uuid(),
  -- Set once Cargo Partner has booked it. Unique: one Hub record per Cargo Partner shipment.
  spot_id text unique check (spot_id ~ '^[0-9]{6,12}$'),
  -- Typed for a shipment kept by hand. A booked one takes Cargo Partner's.
  destination_depot text check (
    destination_depot in ('US-BAL', 'US-SBD', 'CA-HAM', 'EU-SK', 'EU-FR', 'GB-BSE', 'AU-SYD')
  ),
  container_numbers text[] not null default '{}' check (cardinality(container_numbers) <= 10),
  shipper text check (shipper is null or length(btrim(shipper)) between 1 and 80),
  -- Dave's tab, row by row: the date on the order, then the journey.
  booked_on date,
  collected_on date,
  shipped_on date,
  eta_port date,
  eta_depot date,
  delivered_on date,
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  -- A shipment kept by hand has nothing else to say where it is going.
  constraint transport_shipment_has_a_destination check (spot_id is not null or destination_depot is not null)
);

create table if not exists public.transport_shipment_line (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.transport_shipment (id) on delete cascade,
  position smallint not null check (position between 0 and 99),
  -- The depot's Xero item code (H10HERCB, H9BALT, CS1BALT), which is what a PO line carries.
  product_code text not null check (length(btrim(product_code)) between 1 and 40),
  description text check (description is null or length(description) <= 200),
  quantity numeric(12, 2) not null check (quantity > 0),
  pallets numeric(8, 2) check (pallets is null or pallets >= 0),
  -- Group's order (EBG00001) and the depot's own (EBUSA00001, or the older USA00001).
  group_order_no text check (group_order_no is null or length(btrim(group_order_no)) between 1 and 40),
  local_order_no text check (local_order_no is null or length(btrim(local_order_no)) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists transport_shipment_line_shipment_idx on public.transport_shipment_line (shipment_id, position);
create index if not exists transport_shipment_depot_idx on public.transport_shipment (destination_depot);

create trigger transport_shipment_set_updated_at
  before update on public.transport_shipment
  for each row execute function public.set_updated_at();
create trigger transport_shipment_line_set_updated_at
  before update on public.transport_shipment_line
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Saving the contents in one go
-- ---------------------------------------------------------------------------
-- The page sends the whole list. Lines it kept carry their id and are updated in place, so columns
-- this list does not own (the commercial invoice a line is on, from the landed cost) survive an
-- edit of the contents. Lines it dropped are deleted and new ones inserted, all in one
-- transaction, so a refused line leaves the list as it was rather than half saved.
create or replace function public.transport_save_shipment_lines(p_shipment_id uuid, p_lines jsonb, p_user uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  kept uuid[];
begin
  if not exists (select 1 from transport_shipment where id = p_shipment_id) then
    raise exception 'no such shipment' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'the lines must be a list' using errcode = '22023';
  end if;

  select coalesce(array_agg((l ->> 'id')::uuid), '{}')
    into kept
    from jsonb_array_elements(p_lines) l
   where nullif(l ->> 'id', '') is not null;

  if exists (
    select 1 from unnest(kept) k
     where not exists (select 1 from transport_shipment_line t where t.id = k and t.shipment_id = p_shipment_id)
  ) then
    raise exception 'a line does not belong to this shipment' using errcode = '22023';
  end if;

  delete from transport_shipment_line where shipment_id = p_shipment_id and not (id = any (kept));

  update transport_shipment_line t
     set position = (l ->> 'position')::smallint,
         product_code = btrim(l ->> 'product_code'),
         description = nullif(btrim(coalesce(l ->> 'description', '')), ''),
         quantity = (l ->> 'quantity')::numeric,
         pallets = nullif(l ->> 'pallets', '')::numeric,
         group_order_no = nullif(btrim(coalesce(l ->> 'group_order_no', '')), ''),
         local_order_no = nullif(btrim(coalesce(l ->> 'local_order_no', '')), '')
    from jsonb_array_elements(p_lines) l
   where nullif(l ->> 'id', '') is not null
     and t.id = (l ->> 'id')::uuid;

  insert into transport_shipment_line
    (shipment_id, position, product_code, description, quantity, pallets, group_order_no, local_order_no)
  select p_shipment_id,
         (l ->> 'position')::smallint,
         btrim(l ->> 'product_code'),
         nullif(btrim(coalesce(l ->> 'description', '')), ''),
         (l ->> 'quantity')::numeric,
         nullif(l ->> 'pallets', '')::numeric,
         nullif(btrim(coalesce(l ->> 'group_order_no', '')), ''),
         nullif(btrim(coalesce(l ->> 'local_order_no', '')), '')
    from jsonb_array_elements(p_lines) l
   where nullif(l ->> 'id', '') is null;

  update transport_shipment set updated_by = p_user where id = p_shipment_id;
end $$;

-- Same stance as the cargo tables: the Hub reads and writes them with the service role, after its
-- own capability and organisation checks. No policy for a browser key to get wrong.
alter table public.transport_shipment enable row level security;
alter table public.transport_shipment_line enable row level security;

do $$
declare t text;
begin
  foreach t in array array['transport_shipment', 'transport_shipment_line']
  loop
    execute format('drop policy if exists "Service role full access" on public.%I', t);
    execute format(
      'create policy "Service role full access" on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

revoke all on function public.transport_save_shipment_lines(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.transport_save_shipment_lines(uuid, jsonb, uuid) to service_role;

comment on table public.transport_shipment is
  'The Hub''s own record of a shipment: a Cargo Partner SPOT ID when booked, otherwise kept by hand. Service role only; the Hub checks transport.view and the depot.';
comment on table public.transport_shipment_line is
  'What is on a shipment, one row per product. Not read by the MRP. Service role only.';

-- ---------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['transport_shipment', 'transport_shipment_line']
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
  if has_function_privilege('anon', 'public.transport_save_shipment_lines(uuid, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.transport_save_shipment_lines(uuid, jsonb, uuid)', 'execute') then
    raise exception 'anon or authenticated can still run transport_save_shipment_lines';
  end if;
end $$;
