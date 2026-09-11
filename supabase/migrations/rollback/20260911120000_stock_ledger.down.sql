-- Rollback of 20260911120000_stock_ledger.sql.
--
-- Drops the ledger and the material balances, restores the two old writers
-- verbatim, and puts warehouse_stock_levels' policy and grants back to the
-- pre-state recorded in the up file's header. The 22 retired EB-SRO SK rows
-- are NOT recreated: they were all zero and never counted, so nothing is lost
-- and they would only come back as the same dead rows.

drop trigger if exists trg_stock_on_booking on public.po_shipments;
drop function if exists public.stock_on_booking();
drop function if exists public.hub_record_stock_count(text, text, jsonb, uuid, uuid, text);
drop function if exists public.hub_apply_stock_movements(jsonb, uuid);

-- increment_stock, verbatim from 20260807000200_hub_increment_stock_rpc.sql
create or replace function public.increment_stock(p_warehouse text, p_sku text, p_delta integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into warehouse_stock_levels (warehouse_code, sku, quantity_on_hand, last_counted_at, updated_at)
  values (p_warehouse, p_sku, p_delta, now(), now())
  on conflict (warehouse_code, sku) do update
    set quantity_on_hand = warehouse_stock_levels.quantity_on_hand + p_delta,
        updated_at = now();
$$;
revoke all on function public.increment_stock(text, text, integer) from public, anon, authenticated;
grant execute on function public.increment_stock(text, text, integer) to service_role;

-- hub_upsert_warehouse_stock, verbatim from 20260625000000_hub_upsert_warehouse_stock_rpc.sql
create or replace function public.hub_upsert_warehouse_stock(rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  with input as (
    select
      (r->>'warehouse_code')::text      as warehouse_code,
      (r->>'sku')::text                 as sku,
      nullif(r->>'product_name','')     as product_name,
      (r->>'quantity_on_hand')::integer as quantity_on_hand
    from jsonb_array_elements(rows) as r
    where r->>'warehouse_code' is not null
      and r->>'sku' is not null
      and r->>'quantity_on_hand' is not null
  ),
  upserted as (
    insert into public.warehouse_stock_levels
      (warehouse_code, sku, product_name, quantity_on_hand, last_counted_at, updated_at)
    select warehouse_code, sku, product_name, quantity_on_hand, now(), now() from input
    on conflict (warehouse_code, sku) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          product_name     = coalesce(excluded.product_name, public.warehouse_stock_levels.product_name),
          last_counted_at  = now(),
          updated_at       = now()
    returning 1
  )
  select count(*) into n from upserted;
  return n;
end;
$$;

comment on function public.apply_manufacturing_stocktake(uuid) is null;

-- warehouse_stock_levels pre-state
grant insert, select, update, delete, truncate, references, trigger on public.warehouse_stock_levels to anon;
grant insert, update, delete, truncate, references, trigger on public.warehouse_stock_levels to authenticated;
create policy "Authenticated users can update warehouse_stock_levels"
  on public.warehouse_stock_levels for update to authenticated using (true) with check (true);

delete from public.user_capabilities where capability = 'stock.view';
delete from public.capabilities where key = 'stock.view';
update public.capabilities
   set description = 'Override warehouse stock levels (the dummy-stock override path)'
 where key = 'stock.edit';

drop table if exists public.material_stock_levels;
drop table if exists public.stock_movements;
