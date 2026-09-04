-- Restore enrich_line_items_with_xero() to its pre-split form and drop the
-- helper functions.
--
-- NOTE: rolling back does NOT unsplit rows already written. Any deals_registry
-- row saved while the split was live keeps its hook and bungee lines, which is
-- the safe direction: those lines carry real Xero item codes, and rewriting
-- line_items_raw to undo them would re-fire notify_quote_accepted() and raise a
-- duplicate Xero quote on every accepted deal touched.

create or replace function public.enrich_line_items_with_xero()
returns trigger
language plpgsql
as $$
declare
  enriched_data jsonb;
begin
  if new.line_items_raw is not null
     and jsonb_array_length(new.line_items_raw) > 0
     and new.depot_code is not null then

    select
      jsonb_agg(
        item || jsonb_build_object(
          'xero_item_code', m.xero_item_code,
          'xero_item_description', m.xero_item_description,
          'xero_org', m.xero_org,
          'mapping_status', case
                              when m.xero_item_code is not null then 'MATCHED'
                              else 'MISSING_MAPPING'
                            end
        )
      )
    into enriched_data
    from jsonb_array_elements(new.line_items_raw) as item
    left join public.product_depot_mapping m
      on m.hubspot_sku_code = (item->>'sku')
      and m.depot_code = new.depot_code;

    new.line_items_raw := enriched_data;
  end if;

  return new;
end;
$$;

drop function if exists public.split_fitting_kit_lines(jsonb, text);
drop function if exists public.is_fitting_kit_line(jsonb);
drop function if exists public.line_item_numeric(jsonb, text);
