-- Undo 20260922140000_xero_items_in_depot_mapping.
--
-- 🔴 THIS DELETES ROWS, and it has to. The migration made hubspot_sku_code optional so that Xero
-- items with no HubSpot SKU could be recorded. Putting NOT NULL back is impossible while those
-- rows exist, so they go. Every one is re-derivable: the reconcile recreates them from Xero on its
-- next run.
--
-- It will NOT delete a row a person made. Only rows with no HubSpot SKU are removed, and if any of
-- those was made by hand rather than by the sync this script STOPS and says how many, rather than
-- throwing away somebody's decision.
--
-- unique_sku_per_depot is deliberately not touched. It is a CONSTRAINT in this database, not a
-- bare index, the migration never dropped it, and DROP INDEX cannot remove it.

do $$
declare
  manual_skuless int;
  going int;
begin
  select count(*) into manual_skuless
  from public.product_depot_mapping
  where hubspot_sku_code is null and source is distinct from 'xero';

  if manual_skuless > 0 then
    raise exception
      '% rows with no HubSpot SKU were made by hand, not by the sync. Give them a SKU or delete them deliberately before rolling back.',
      manual_skuless;
  end if;

  select count(*) into going from public.product_depot_mapping where hubspot_sku_code is null;
  raise notice 'removing % product_depot_mapping rows that have no HubSpot SKU', going;
end $$;

delete from public.product_depot_mapping where hubspot_sku_code is null;

drop function if exists public.sync_xero_items(text, jsonb);
drop function if exists public.depot_for_xero_item(text, text);
drop table if exists public.xero_org_depot_rule;

drop index if exists public.unique_xero_item_when_no_sku;
drop index if exists public.idx_product_mapping_source;
drop index if exists public.idx_product_mapping_xero_item;

alter table public.product_depot_mapping
  drop constraint if exists product_depot_mapping_source_known,
  drop column if exists xero_is_archived,
  drop column if exists xero_purchase_account_code,
  drop column if exists xero_sales_account_code,
  drop column if exists xero_unit_price,
  drop column if exists last_seen_in_xero_at,
  drop column if exists source,
  drop column if exists xero_item_id;

alter table public.product_depot_mapping alter column hubspot_sku_code set not null;

do $$
begin
  if (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'product_depot_mapping'
        and column_name = 'hubspot_sku_code') <> 'NO' then
    raise exception 'hubspot_sku_code is still nullable';
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'xero_org_depot_rule') then
    raise exception 'xero_org_depot_rule survived the rollback';
  end if;
  -- The original constraint must have been left alone throughout.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_depot_mapping'::regclass and conname = 'unique_sku_per_depot'
  ) then
    raise exception 'unique_sku_per_depot was destroyed; it should never have been touched';
  end if;
end $$;
