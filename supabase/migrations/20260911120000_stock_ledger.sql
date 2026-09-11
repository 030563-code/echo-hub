-- The stock ledger: every change to a stock level becomes a movement row, and
-- s.r.o.-owned raw materials get a balance table of their own.
--
-- Dean, 9 Sep 2026: "this thing must be able to deduct stock accurately and
-- calculate committed stock and stock on hand across the stock board from
-- s.r.o to depots. We have that warehouse_stock_levels table and would be
-- worth to add the material stock that we get from there too."
--
-- Until now warehouse_stock_levels only ever went up. Its sole automatic
-- writer was the depot receipt (increment_stock); nothing deducted on
-- fulfilment, shipping or sale, nothing recorded why a number changed, and a
-- rep with the UPDATE policy could set any level to anything. This migration
-- puts one append-only table under both balances and makes two RPCs the only
-- way to move them.
--
-- What is untouched: warehouse_stock_levels keeps its shape and its readers
-- (the MRP engine, the MRP board, the PO create form, the PO page). The Bamida
-- ONIX feed (bamida_material_stock) is Bamida's stock, not ours, and is not
-- part of this. apply_manufacturing_stocktake stays as it is (see the comment
-- at the end).
--
-- Live pre-state of warehouse_stock_levels, read 11 Sep 2026 before this ran:
--   RLS enabled. Policies: "Authenticated users can read warehouse_stock_levels"
--   (SELECT, authenticated), "Authenticated users can update
--   warehouse_stock_levels" (UPDATE, authenticated), "Service role full access
--   on warehouse_stock_levels" (ALL, public). Grants: anon and authenticated
--   each held INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER.
--   The rollback file restores exactly that.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

create table public.stock_movements (
  id                uuid primary key default gen_random_uuid(),
  item_kind         text not null check (item_kind in ('finished', 'material')),
  warehouse_code    text not null,
  -- finished: the order-line code (EBH9NA); material: mrp_bom_map.component_code
  sku               text not null,
  kind              text not null check (kind in (
                      'receipt', 'count', 'manufactured', 'shipped_out',
                      'customer_dispatch', 'material_consumed', 'adjustment')),
  -- signed delta
  quantity          numeric(14,3) not null check (quantity <> 0),
  balance_after     numeric(14,3) not null,
  -- what caused it: po_line_receipt | po_manufacturing | po_shipment |
  -- customer_invoice | count | adjustment, and the id of that thing
  ref_type          text not null,
  ref_id            text not null,
  estimated         boolean not null default false,
  note              text,
  created_by_uid    uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  -- Phase 2 (Xero postings through n8n) stamps this. Nothing reads it yet.
  posted_to_xero_at timestamptz,
  constraint stock_movements_finished_integral
    check (item_kind = 'material' or quantity = trunc(quantity))
);

comment on table public.stock_movements is
  'Append-only ledger behind warehouse_stock_levels and material_stock_levels. Written only by hub_apply_stock_movements and hub_record_stock_count.';
comment on column public.stock_movements.ref_id is
  'With kind, ref_type, warehouse_code and sku this is the idempotency key: a retried hook applies nothing twice.';
comment on column public.stock_movements.estimated is
  'True when the quantity is inferred rather than observed: material consumption from an unverified BOM, or a rounded invoice line. The next count resets the level.';
comment on column public.stock_movements.posted_to_xero_at is
  'Phase 2. Set by n8n once the movement has been posted to s.r.o. Xero. Null until then.';

-- THE IDEMPOTENCY RULE. One movement per (kind, cause, place, item). A retried
-- receipt, a re-resolved booking, a double-submitted count: the second insert
-- conflicts here and the RPC counts it as skipped without touching the balance.
create unique index stock_movements_once
  on public.stock_movements (kind, ref_type, ref_id, warehouse_code, sku);
create index stock_movements_item_idx
  on public.stock_movements (warehouse_code, sku, created_at desc);
create index stock_movements_unposted_idx
  on public.stock_movements (created_at) where posted_to_xero_at is null;

-- Served by the app on the service role, never by PostgREST. RLS does not
-- restrain TRUNCATE and this project grants authenticated TRUNCATE on every new
-- table in public by default, so the grants go rather than being narrowed.
alter table public.stock_movements enable row level security;
revoke all on public.stock_movements from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. s.r.o.-owned raw materials
-- ---------------------------------------------------------------------------

create table public.material_stock_levels (
  id              uuid primary key default gen_random_uuid(),
  warehouse_code  text not null,
  -- mrp_bom_map.component_code (PC350FR-UV21, ACI-T40, ...)
  component_code  text not null,
  description     text,
  unit            text,
  quantity        numeric(14,3) not null default 0,
  last_counted_at timestamptz,
  updated_at      timestamptz not null default now(),
  unique (warehouse_code, component_code)
);

comment on table public.material_stock_levels is
  'Raw materials Echo Barrier s.r.o. owns and supplies to Bamida. Bamida''s own materials are bamida_material_stock (ONIX feed) and are not here. Balance maintained by the stock ledger RPCs only.';

alter table public.material_stock_levels enable row level security;
revoke all on public.material_stock_levels from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. warehouse_stock_levels: the balance is the ledger's to move, not a rep's
-- ---------------------------------------------------------------------------

drop policy if exists "Authenticated users can update warehouse_stock_levels" on public.warehouse_stock_levels;
revoke all on public.warehouse_stock_levels from anon;
revoke insert, update, delete, truncate, references, trigger on public.warehouse_stock_levels from authenticated;
-- SELECT stays: the PO create form and the PO page read it with the user client.

-- Retire the 22 EB-SRO rows keyed on SK codes (EBH9SK ...). Dean, 9 Sep 2026
-- (D4): one SKU namespace, the order-line codes. All 22 are zero and never
-- counted. The two ..SR codes are listed on purpose; a like '%SK' would miss
-- them. The count guard refuses to run on drift rather than deleting something
-- a count has since touched.
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from public.warehouse_stock_levels
   where warehouse_code = 'EB-SRO'
     and quantity_on_hand = 0
     and last_counted_at is null
     and sku in ('EBH9SK','EBH10SK','EBH9WSK','EBH9X21SK','EBH9X15SK','EBH8SK','EBHT35SK',
                 'EBH9JAPSK','EBH10JAPSK','EBH10HBSK','EBH9MINISK','EBH8MINISK','HERASSK',
                 'NDS200SK','NDTSK','CSFSSR','CSCSSR','CSPTSK','CSPWSK','V2SK','M1SK','GENEXTSK');
  if v_n <> 22 then
    raise exception 'expected 22 untouched EB-SRO SK rows to retire, found %', v_n;
  end if;
  delete from public.warehouse_stock_levels
   where warehouse_code = 'EB-SRO'
     and quantity_on_hand = 0
     and last_counted_at is null
     and sku in ('EBH9SK','EBH10SK','EBH9WSK','EBH9X21SK','EBH9X15SK','EBH8SK','EBHT35SK',
                 'EBH9JAPSK','EBH10JAPSK','EBH10HBSK','EBH9MINISK','EBH8MINISK','HERASSK',
                 'NDS200SK','NDTSK','CSFSSR','CSCSSR','CSPTSK','CSPWSK','V2SK','M1SK','GENEXTSK');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Capability: stock.view reads the board, stock.edit records counts
-- ---------------------------------------------------------------------------

insert into public.capabilities (key, module, description)
values ('stock.view', 'stock', 'View the stock board (on hand, committed, inbound, materials)')
on conflict (key) do update set module = excluded.module, description = excluded.description;

update public.capabilities
   set description = 'Record stock counts and manual adjustments on the stock board'
 where key = 'stock.edit';

-- Whoever could already edit stock can see the board. Nobody holds stock.edit
-- today (super admins see everything without it), so this is for the future.
insert into public.user_capabilities (user_id, capability)
select user_id, 'stock.view' from public.user_capabilities where capability = 'stock.edit'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. Apply movements: the one way a balance moves
-- ---------------------------------------------------------------------------

create or replace function public.hub_apply_stock_movements(p_rows jsonb, p_uid uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r          jsonb;
  v_kind     text;
  v_item     text;
  v_wh       text;
  v_sku      text;
  v_qty      numeric;
  v_ref_type text;
  v_ref_id   text;
  v_est      boolean;
  v_note     text;
  v_bal      numeric;
  v_id       uuid;
  v_applied  integer := 0;
  v_skipped  integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'hub_apply_stock_movements: p_rows must be a json array';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_item     := r->>'item_kind';
    v_wh       := r->>'warehouse_code';
    v_sku      := r->>'sku';
    v_kind     := r->>'kind';
    v_qty      := (r->>'quantity')::numeric;
    v_ref_type := r->>'ref_type';
    v_ref_id   := r->>'ref_id';
    v_est      := coalesce((r->>'estimated')::boolean, false);
    v_note     := r->>'note';

    if v_item not in ('finished', 'material') then
      raise exception 'hub_apply_stock_movements: bad item_kind %', v_item;
    end if;
    if v_wh is null or v_sku is null or v_kind is null or v_ref_type is null or v_ref_id is null then
      raise exception 'hub_apply_stock_movements: warehouse_code, sku, kind, ref_type and ref_id are all required';
    end if;
    if v_qty is null or v_qty = 0 then
      raise exception 'hub_apply_stock_movements: quantity must be a non-zero number (% % %)', v_wh, v_sku, v_kind;
    end if;

    -- Make sure the balance row exists, then lock it for the read-add-write.
    if v_item = 'finished' then
      insert into public.warehouse_stock_levels (warehouse_code, sku, quantity_on_hand, updated_at)
      values (v_wh, v_sku, 0, now())
      on conflict (warehouse_code, sku) do nothing;
      select quantity_on_hand into v_bal
        from public.warehouse_stock_levels
       where warehouse_code = v_wh and sku = v_sku
         for update;
    else
      insert into public.material_stock_levels (warehouse_code, component_code, quantity, updated_at)
      values (v_wh, v_sku, 0, now())
      on conflict (warehouse_code, component_code) do nothing;
      select quantity into v_bal
        from public.material_stock_levels
       where warehouse_code = v_wh and component_code = v_sku
         for update;
    end if;

    -- The movement. A duplicate (same kind, cause, place, item) conflicts on
    -- stock_movements_once and returns no id: skipped, balance untouched.
    insert into public.stock_movements
      (item_kind, warehouse_code, sku, kind, quantity, balance_after,
       ref_type, ref_id, estimated, note, created_by_uid)
    values
      (v_item, v_wh, v_sku, v_kind, v_qty, v_bal + v_qty,
       v_ref_type, v_ref_id, v_est, v_note, p_uid)
    on conflict (kind, ref_type, ref_id, warehouse_code, sku) do nothing
    returning id into v_id;

    if v_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_item = 'finished' then
      update public.warehouse_stock_levels
         set quantity_on_hand = (v_bal + v_qty)::integer,
             updated_at = now()
       where warehouse_code = v_wh and sku = v_sku;
    else
      update public.material_stock_levels
         set quantity = v_bal + v_qty,
             updated_at = now()
       where warehouse_code = v_wh and component_code = v_sku;
    end if;
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end
$$;

revoke all on function public.hub_apply_stock_movements(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.hub_apply_stock_movements(jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Record a count: the level becomes what was counted, the date is stamped
-- ---------------------------------------------------------------------------

create or replace function public.hub_record_stock_count(
  p_item_kind text,
  p_warehouse text,
  p_rows      jsonb,
  p_batch_id  uuid,
  p_uid       uuid,
  p_note      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r         jsonb;
  v_sku     text;
  v_counted numeric;
  v_name    text;
  v_unit    text;
  v_before  numeric;
  v_delta   numeric;
  v_id      uuid;
  v_applied boolean;
  v_out     jsonb := '[]'::jsonb;
begin
  if p_item_kind not in ('finished', 'material') then
    raise exception 'hub_record_stock_count: bad item_kind %', p_item_kind;
  end if;
  if p_warehouse is null or p_batch_id is null then
    raise exception 'hub_record_stock_count: warehouse and batch id are required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'hub_record_stock_count: p_rows must be a json array';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_sku     := r->>'sku';
    v_counted := (r->>'counted')::numeric;
    v_name    := coalesce(r->>'product_name', r->>'description');
    v_unit    := r->>'unit';
    if v_sku is null or v_counted is null or v_counted < 0 then
      raise exception 'hub_record_stock_count: each row needs a sku and a count of zero or more (%)', v_sku;
    end if;
    if p_item_kind = 'finished' and v_counted <> trunc(v_counted) then
      raise exception 'hub_record_stock_count: finished goods are counted in whole units (% = %)', v_sku, v_counted;
    end if;

    if p_item_kind = 'finished' then
      insert into public.warehouse_stock_levels (warehouse_code, sku, product_name, quantity_on_hand, updated_at)
      values (p_warehouse, v_sku, v_name, 0, now())
      on conflict (warehouse_code, sku) do nothing;
      select quantity_on_hand into v_before
        from public.warehouse_stock_levels
       where warehouse_code = p_warehouse and sku = v_sku
         for update;
    else
      insert into public.material_stock_levels (warehouse_code, component_code, description, unit, quantity, updated_at)
      values (p_warehouse, v_sku, v_name, v_unit, 0, now())
      on conflict (warehouse_code, component_code) do nothing;
      select quantity into v_before
        from public.material_stock_levels
       where warehouse_code = p_warehouse and component_code = v_sku
         for update;
    end if;

    v_delta   := v_counted - v_before;
    v_applied := false;
    v_id      := null;

    -- A count that changes nothing writes no movement: the date stamp below is
    -- the whole record of it. A retried batch id conflicts and applies nothing.
    if v_delta <> 0 then
      insert into public.stock_movements
        (item_kind, warehouse_code, sku, kind, quantity, balance_after,
         ref_type, ref_id, estimated, note, created_by_uid)
      values
        (p_item_kind, p_warehouse, v_sku, 'count', v_delta, v_counted,
         'count', p_batch_id::text, false, p_note, p_uid)
      on conflict (kind, ref_type, ref_id, warehouse_code, sku) do nothing
      returning id into v_id;
      v_applied := v_id is not null;
    end if;

    if p_item_kind = 'finished' then
      update public.warehouse_stock_levels
         set quantity_on_hand = case when v_applied then v_counted::integer else quantity_on_hand end,
             product_name     = coalesce(v_name, product_name),
             last_counted_at  = now(),
             updated_at       = now()
       where warehouse_code = p_warehouse and sku = v_sku;
    else
      update public.material_stock_levels
         set quantity        = case when v_applied then v_counted else quantity end,
             description     = coalesce(v_name, description),
             unit            = coalesce(v_unit, unit),
             last_counted_at = now(),
             updated_at      = now()
       where warehouse_code = p_warehouse and component_code = v_sku;
    end if;

    v_out := v_out || jsonb_build_object(
      'sku', v_sku, 'before', v_before, 'counted', v_counted,
      'delta', v_delta, 'applied', v_applied);
  end loop;

  return v_out;
end
$$;

revoke all on function public.hub_record_stock_count(text, text, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hub_record_stock_count(text, text, jsonb, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Booking deducts EB-SRO. Dean, 9 Sep 2026 (D1): fulfil-from-stock commits,
--    the Cargo Partner booking deducts.
-- ---------------------------------------------------------------------------
--
-- A trigger rather than a hook in the resolver, because po_shipments has three
-- writers today (Detect, Refresh, the sync sweep) and a scheduled sweep to
-- come, and the upsert cannot tell "first spot stored" from "re-resolved".
-- The trigger can: it fires on the first non-null spot_id only.
--
-- The goods leaving EB-SRO are the SRO-leg order's lines, whichever PO in the
-- chain the spot attached to. Best effort: a ledger failure warns and the
-- booking still persists, mirroring recordReceipt's stance.

create or replace function public.stock_on_booking()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sro  uuid;
  v_rows jsonb;
begin
  if new.spot_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.spot_id is not null then return new; end if;

  -- The SRO leg itself, or the SRO leg of the chain this PO belongs to.
  select id into v_sro
    from public.purchase_orders
   where id = new.po_id and leg = 'EB_GROUP_TO_SRO';
  if v_sro is null then
    select s.id into v_sro
      from public.purchase_orders p
      join public.purchase_orders s on s.master_ref = p.master_ref
     where p.id = new.po_id and s.leg = 'EB_GROUP_TO_SRO'
     limit 1;
  end if;
  if v_sro is null then return new; end if;   -- a legacy single-leg order: nothing leaves EB-SRO

  select jsonb_agg(jsonb_build_object(
           'item_kind', 'finished',
           'warehouse_code', 'EB-SRO',
           'sku', l.sku,
           'kind', 'shipped_out',
           'quantity', -l.quantity,
           'ref_type', 'po_shipment',
           'ref_id', v_sro::text,
           'note', 'Booked with Cargo Partner, SPOT ' || new.spot_id))
    into v_rows
    from public.purchase_order_lines l
   where l.po_id = v_sro and l.sku is not null and l.quantity > 0;

  if v_rows is not null then
    perform public.hub_apply_stock_movements(v_rows, null);
  end if;
  return new;
exception when others then
  raise warning 'stock_on_booking skipped for po %: %', new.po_id, sqlerrm;
  return new;
end
$$;

drop trigger if exists trg_stock_on_booking on public.po_shipments;
create trigger trg_stock_on_booking
  after insert or update of spot_id on public.po_shipments
  for each row execute function public.stock_on_booking();

-- ---------------------------------------------------------------------------
-- 8. The old writers
-- ---------------------------------------------------------------------------

-- increment_stock's only caller (recordReceipt) now goes through the ledger.
-- Leaving it would keep a second writer that bypasses it.
drop function if exists public.increment_stock(text, text, integer);

-- The old n8n count feed keeps its signature and becomes ledger-aware: each
-- warehouse's rows are recorded as a count batch. Zero callers in the Hub
-- today; kept so any n8n caller stays honest rather than breaking.
create or replace function public.hub_upsert_warehouse_stock(rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wh   text;
  v_rows jsonb;
  n      integer := 0;
begin
  for v_wh, v_rows in
    select r->>'warehouse_code',
           jsonb_agg(jsonb_build_object(
             'sku', r->>'sku',
             'counted', (r->>'quantity_on_hand')::numeric,
             'product_name', nullif(r->>'product_name', '')))
      from jsonb_array_elements(rows) as r
     where r->>'warehouse_code' is not null
       and r->>'sku' is not null
       and r->>'quantity_on_hand' is not null
     group by r->>'warehouse_code'
  loop
    perform public.hub_record_stock_count('finished', v_wh, v_rows, gen_random_uuid(), null,
                                          'hub_upsert_warehouse_stock count feed');
    n := n + jsonb_array_length(v_rows);
  end loop;
  return n;
end
$$;

comment on function public.apply_manufacturing_stocktake(uuid) is
  'Legacy n8n stocktake writer (May 2026 ONIX design). Bypasses the stock ledger. Retire in the Xero phase; do not call from the Hub.';
