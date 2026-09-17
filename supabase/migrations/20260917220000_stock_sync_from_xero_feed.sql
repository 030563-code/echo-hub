-- The Xero feed flows into warehouse_stock_levels, which is now the single source of truth.
--
-- Part two of the consolidation Dean asked for. Part one (20260917210000) added the source column
-- and extended product_depot_mapping to UK, France and Group. This one moves the figures.
--
-- 🔴 THREE GUARDS, and they are the point of this function, not decoration:
--
--  1. A COUNTED ROW IS NEVER OVERWRITTEN. The North American depots were physically counted on
--     16 September and the stock ledger writes movements against them. A daily API figure must
--     never silently replace a count. The upsert only writes where the row is new or where it
--     already carries source = 'xero_sync'.
--  2. RAW MATERIALS ARE NOT FINISHED GOODS. The Group feed is 17,777 units of grommets, rivets,
--     webbing, Gortex and PVC against about 100 units of finished product. Those belong in
--     bamida_material_stock and material_stock_levels, which already exist for exactly that, and
--     they are excluded here by the simple fact that no mapping row claims them.
--  3. last_counted_at IS LEFT ALONE. A synced figure is not a count. The engine's
--     stock_unverified flag reads that column and it would be a lie to stamp it here.
create or replace function public.hub_sync_xero_stock_to_warehouse()
returns table (depot text, skus int, units numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with latest as (
    -- One row per organisation and item, from that organisation's most recent snapshot.
    select distinct on (s.xero_org, s.xero_item_code)
      s.xero_org, s.xero_item_code, s.qty_on_hand, s.snapshot_date
    from public.xero_stock_snapshot s
    order by s.xero_org, s.xero_item_code, s.snapshot_date desc
  ),
  mapped as (
    select
      m.depot_code,
      m.hubspot_sku_code as sku,
      sum(l.qty_on_hand) as qty,
      -- Several Xero codes can resolve to one SKU, so the trace keeps all of them.
      string_agg(distinct l.xero_item_code, '+' order by l.xero_item_code) as codes,
      min(m.xero_org) as org
    from latest l
    join public.product_depot_mapping m
      on m.xero_org = l.xero_org
     and lower(trim(m.xero_item_code)) = lower(trim(l.xero_item_code))
     and m.is_active
    where l.xero_org in ('UK', 'FRANCE', 'GROUP', 'AUSTRALIA')
    group by m.depot_code, m.hubspot_sku_code
  ),
  written as (
    insert into public.warehouse_stock_levels
      (warehouse_code, sku, quantity_on_hand, source, source_org, source_item_code, source_synced_at, updated_at)
    select w.depot_code, w.sku, w.qty::int, 'xero_sync', w.org, w.codes, now(), now()
    from mapped w
    on conflict (warehouse_code, sku) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          source_org = excluded.source_org,
          source_item_code = excluded.source_item_code,
          source_synced_at = excluded.source_synced_at,
          updated_at = now()
      -- Guard 1. A counted row wins over a synced figure, always.
      where public.warehouse_stock_levels.source = 'xero_sync'
    returning warehouse_code, sku, quantity_on_hand
  )
  select written.warehouse_code, count(*)::int, sum(written.quantity_on_hand)::numeric
  from written
  group by written.warehouse_code;
end;
$$;

comment on function public.hub_sync_xero_stock_to_warehouse() is
  'Pushes the newest xero_stock_snapshot figures into warehouse_stock_levels for UK, France, Group and Australia, resolved through product_depot_mapping. Never overwrites a row whose source is "count", never stamps last_counted_at, and only moves items a mapping row claims, so raw materials stay out of the finished-goods ledger.';

revoke all on function public.hub_sync_xero_stock_to_warehouse() from public, anon;
grant execute on function public.hub_sync_xero_stock_to_warehouse() to service_role;

-- ---------------------------------------------------------------------------
-- Keep it current without touching Dave's workflows
-- ---------------------------------------------------------------------------
-- The daily reports write xero_stock_snapshot and know nothing about this. A statement-level
-- trigger means the ledger updates itself the moment the feed lands, with no change to any n8n
-- workflow and nothing new for anyone to remember to run.
create or replace function public.trg_xero_stock_snapshot_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.hub_sync_xero_stock_to_warehouse();
  return null;
end;
$$;

drop trigger if exists xero_stock_snapshot_sync on public.xero_stock_snapshot;
create trigger xero_stock_snapshot_sync
  after insert or update on public.xero_stock_snapshot
  for each statement
  execute function public.trg_xero_stock_snapshot_sync();
