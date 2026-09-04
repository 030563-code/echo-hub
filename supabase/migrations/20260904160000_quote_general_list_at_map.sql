-- General list prices now quote at MAP, not MSRP.
--
-- Dean's call, 2026-09-04 evening, after Jillian hit it live: the price load
-- earlier today made the quote builder autofill MSRP, and every H9 she had
-- quoted before that was MAP or below (245, 245, 250) against an MSRP of 325.
-- The number jumped about a third overnight and she could not bring it down,
-- because rep_discount_caps is empty and a rep with no cap cannot discount at
-- all. Contract prices are unaffected: a contractor already resolves ahead of
-- the list.
--
-- WHY THE DATA AND NOT THE CODE: resolveBasePrice reads list_prices.unit_price,
-- and the Hub has not deployed since 3 September, so a code change would not
-- reach her. Supabase is shared with production, so this does.
--
-- MSRP IS PRESERVED, not overwritten. It is a real price tier and the sheet is
-- not the only place it should live. It moves to its own column, which nothing
-- reads yet; when the Hub next deploys, resolveBasePrice can choose a tier
-- properly instead of the choice being encoded in which column holds what.
alter table public.list_prices
  add column if not exists msrp_price numeric null;

comment on column public.list_prices.msrp_price is
  'MSRP (full list). Reference only: unit_price is what the quote builder charges, and since 2026-09-04 that is MAP.';

comment on column public.list_prices.unit_price is
  'The price the quote builder autofills. MSRP until 2026-09-04, MAP from then on. See msrp_price and map_price for the other two tiers.';

-- Audit every row the way a hand edit through /pricing/list would be audited.
insert into public.pricing_change_log (table_name, row_key, before, after, changed_by_label)
select 'list_prices',
       lp.sku || '|' || lp.currency,
       jsonb_build_object('unit_price', lp.unit_price, 'map_price', lp.map_price, 'floor_price', lp.floor_price),
       jsonb_build_object('unit_price', lp.map_price, 'map_price', lp.map_price, 'floor_price', lp.floor_price,
                          'msrp_price', lp.unit_price),
       'quote at MAP 2026-09-04'
from public.list_prices lp
where lp.map_price is not null
  and lp.msrp_price is null;

update public.list_prices
set msrp_price = unit_price,
    unit_price = map_price,
    updated_by_label = 'quote at MAP 2026-09-04',
    updated_at = now()
where map_price is not null
  -- Idempotent: a row already switched has msrp_price set and is left alone,
  -- so re-running never collapses MAP onto itself and loses MSRP for good.
  and msrp_price is null;
