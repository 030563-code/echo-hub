-- Fitting kits become 1 hook + 2 bungees the moment they land in deals_registry.
--
-- Dean's rule (2026-09-04): a fitting kit reaching deals_registry.line_items_raw
-- is mapped to 2 bungies and 1 hook, carrying the correct xero_item_code, and
-- the kit's money splits 75% hook / 12.5% bungee / 12.5% bungee.
--
-- Why here and not only in the Hub: a kit line carries no SKU, so the existing
-- enrichment join found no product_depot_mapping row and stamped
-- MISSING_MAPPING with a null xero_item_code. Splitting BEFORE that join lets
-- the components resolve their own real codes (HKB/BUNB at Baltimore,
-- HKHM/BUNHAM at Hamilton), which is what the Xero quote and the MCS contract
-- are built from.
--
-- THE IDEMPOTENCY REQUIREMENT IS LOAD-BEARING. notify_quote_accepted() re-posts
-- to the quote-accepted and quote-accepted-mcs webhooks whenever
-- OLD.line_items_raw IS DISTINCT FROM NEW.line_items_raw. Both triggers sit on
-- this table and the BEFORE trigger runs first, so a split that produced a
-- different result on each write would raise a duplicate Xero quote on every
-- unrelated update to the row. Components are therefore stamped with
-- kit_parent_line_key and passed straight through on every later write.

-- Coerce a JSONB field to numeric without ever throwing.
--
-- line_items_raw is written by the n8n HubSpot sync as well as by the Hub, so it
-- is untrusted at this boundary. A bare (item->>'quantity')::numeric on one bad
-- value would abort the trigger and take down EVERY write to deals_registry,
-- not just the offending row.
create or replace function public.line_item_numeric(obj jsonb, field text)
returns numeric
language sql
immutable
as $$
  select case
    when jsonb_typeof(obj -> field) = 'number' then (obj ->> field)::numeric
    when jsonb_typeof(obj -> field) = 'string'
      and btrim(obj ->> field) ~ '^-?[0-9]+(\.[0-9]+)?$' then (btrim(obj ->> field))::numeric
    else 0
  end
$$;

comment on function public.line_item_numeric(jsonb, text) is
  'Numeric value of a line_items_raw field, 0 when absent or unparseable. Never throws.';

-- Mirrors isFittingKitLine() in src/lib/customer-invoice/build-draft.ts. Keep
-- the two in step: the Hub still splits legacy rows written before this
-- migration, and the two must agree on what a kit is.
create or replace function public.is_fitting_kit_line(item jsonb)
returns boolean
language sql
immutable
as $$
  select
    -- The catalogue holds three "Fitting Kit" products, none carrying an hs_sku.
    coalesce(item ->> 'hs_product_id', '') in ('57786096', '138783', '1640211461')
    or (
      coalesce(btrim(item ->> 'sku'), '') = ''
      and coalesce(item ->> 'name', '') ~* 'fitting\s*kit'
      -- Vertical fitting kits (EBVFKNA) are a distinct product, never split.
      -- The pattern also catches the "Verticle" misspelling in the catalogue.
      and coalesce(item ->> 'name', '') !~* 'vertic'
    )
$$;

comment on function public.is_fitting_kit_line(jsonb) is
  'True for a fitting-kit line that should split into hooks and bungees. Vertical kits excluded.';

-- Split every fitting-kit line into its components. Pure and idempotent:
-- split_fitting_kit_lines(split_fitting_kit_lines(x, d), d) = split_fitting_kit_lines(x, d).
create or replace function public.split_fitting_kit_lines(items jsonb, depot text)
returns jsonb
language plpgsql
immutable
as $$
declare
  out_items jsonb := '[]'::jsonb;
  item      jsonb;
  base      jsonb;
  idx       int := 0;
  kit_depot text;
  parent    text;
  kit_label text;
  q  numeric;  -- kits ordered
  ku numeric;  -- kit unit price
  d  numeric;  -- discount %
  kt numeric;  -- kit line total
  bu numeric;  -- bungee unit price
  hu numeric;  -- hook unit price
  bt numeric;  -- bungee line total
  ht numeric;  -- hook line total
begin
  if jsonb_typeof(items) is distinct from 'array' then
    return items;
  end if;

  -- Kits and their components always dispatch from Baltimore whatever depot the
  -- rest of the deal ships from, matching KIT_SHIP_FROM in the Hub. Without
  -- this a US-SBD deal would look for HKNA at San Bernardino, where no mapping
  -- row exists, and land back on MISSING_MAPPING. Canada resolves at CA-HAM.
  kit_depot := case when depot in ('US-BAL', 'US-SBD') then 'US-BAL' else depot end;

  for item in select value from jsonb_array_elements(items) loop
    idx := idx + 1;

    -- Already a component from an earlier write, or not a kit: untouched.
    if (item ? 'kit_parent_line_key') or not public.is_fitting_kit_line(item) then
      out_items := out_items || jsonb_build_array(item);
      continue;
    end if;

    q  := public.line_item_numeric(item, 'quantity');
    ku := public.line_item_numeric(item, 'unit_price');
    d  := public.line_item_numeric(item, 'discount_percentage');
    kt := case
            when item ? 'total_amount' then public.line_item_numeric(item, 'total_amount')
            else round(q * ku * (1 - d / 100), 2)
          end;

    -- The bungee price rounds to the cent and THE HOOK TAKES THE REMAINDER, so
    -- hook + 2 bungees is exactly the kit price and exactly the kit total. An
    -- even 75/12.5/12.5 on both sides would drift a cent on prices that do not
    -- divide by eight, and the deal amount would stop reconciling with its
    -- lines. Preserving the money wins; the hook lands within a cent of 75%.
    bu := round(ku * 0.125, 2);
    hu := ku - 2 * bu;
    bt := round(kt * 0.25, 2);
    ht := kt - bt;

    parent := coalesce(nullif(item ->> 'hs_line_item_id', ''), 'L' || idx);
    kit_label := 'Fitting kit x ' || trim(trailing '.' from to_char(q, 'FM9999999990.99'))
                 || ' (1 hook + 2 bungees per kit)';

    -- Everything the components inherit from the kit. The kit's own identity
    -- and money are dropped; so are the Xero fields, so the enrichment join
    -- below stamps fresh ones for the component's own SKU. list_unit_price goes
    -- too: it described the kit, and would misreport a component's list price.
    base := (item - 'sku' - 'name' - 'quantity' - 'unit_price' - 'total_amount'
                  - 'list_unit_price' - 'xero_item_code' - 'xero_item_description'
                  - 'xero_org' - 'mapping_status')
            || jsonb_build_object(
                 'kit_parent_line_key', parent,
                 'origin', 'kit_split',
                 'ship_from_depot', kit_depot,
                 'discount_percentage', d
               );

    out_items := out_items || jsonb_build_array(
      base || jsonb_build_object(
        'sku', 'HKNA',
        'name', 'Echo Barrier Hooks',
        'quantity', q,
        'unit_price', hu,
        'total_amount', ht,
        'description', kit_label
          || case when coalesce(btrim(item ->> 'description'), '') <> ''
                  then '. ' || btrim(item ->> 'description') else '' end
      ),
      base || jsonb_build_object(
        'sku', 'BUNNA',
        'name', 'Echo Barrier Bungees',
        'quantity', q * 2,
        'unit_price', bu,
        'total_amount', bt,
        'description', kit_label
      )
    );
  end loop;

  return out_items;
end;
$$;

comment on function public.split_fitting_kit_lines(jsonb, text) is
  'Fitting-kit lines become 1 hook + 2 bungees per kit, money split 75/12.5/12.5 with the hook taking the rounding remainder. Idempotent.';

-- The BEFORE trigger: split first, then map to Xero.
create or replace function public.enrich_line_items_with_xero()
returns trigger
language plpgsql
as $$
declare
  enriched_data jsonb;
begin
  if new.line_items_raw is not null
     -- jsonb_array_length() throws on a non-array. n8n writes this column, so
     -- the type is checked rather than assumed.
     and jsonb_typeof(new.line_items_raw) = 'array'
     and jsonb_array_length(new.line_items_raw) > 0 then

    -- Kits split BEFORE the mapping join, so the components resolve their own
    -- xero_item_code instead of the kit landing as MISSING_MAPPING. Runs even
    -- with no depot: the money split does not need one, and the join below is
    -- what needs a depot.
    new.line_items_raw := public.split_fitting_kit_lines(new.line_items_raw, new.depot_code);

    if new.depot_code is not null then
      select jsonb_agg(
        item || jsonb_build_object(
          'xero_item_code', m.xero_item_code,
          'xero_item_description', m.xero_item_description,
          'xero_org', m.xero_org,
          'mapping_status', case
                              when m.xero_item_code is not null then 'MATCHED'
                              else 'MISSING_MAPPING'
                            end
        )
        -- ORDER BY is not cosmetic. jsonb_agg without one leaves line order at
        -- the planner's discretion, and a reshuffle makes line_items_raw differ
        -- from itself on an unrelated update, which is exactly what
        -- notify_quote_accepted() reads as a change worth re-posting to Xero.
        order by ord
      )
      into enriched_data
      from jsonb_array_elements(new.line_items_raw) with ordinality as t(item, ord)
      left join public.product_depot_mapping m
        on m.hubspot_sku_code = (item ->> 'sku')
        -- A kit component carries its own dispatch depot (Baltimore); every
        -- other line maps at the deal's depot, as before.
        and m.depot_code = coalesce(nullif(item ->> 'ship_from_depot', ''), new.depot_code);

      new.line_items_raw := enriched_data;
    end if;
  end if;

  return new;
end;
$$;
