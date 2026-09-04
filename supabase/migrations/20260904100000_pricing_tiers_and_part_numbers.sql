-- The price sheets carry three tiers, not one: Distributor Net, MAP (Advertised)
-- and MSRP (LIST). list_prices only had room for two of them.
--
-- Dean's call 2026-09-04: quote from MSRP and let the rep discount down, with
-- Distributor Net as the floor they cannot cross. That maps onto the existing
-- columns without renaming anything:
--
--   unit_price   = MSRP (LIST)          the quote builder's starting price
--   map_price    = MAP (Advertised)     reference only, never auto-applied
--   floor_price  = Distributor Net      the hard floor checkDiscount enforces
--
-- The existing floor <= list validation in save-pricing.ts holds unchanged,
-- because Distributor Net is always below MSRP on every sheet.
alter table public.list_prices
  add column if not exists map_price numeric;

comment on column public.list_prices.unit_price is
  'MSRP (LIST) from the price sheet. The quote builder starts a line here and the rep discounts down.';
comment on column public.list_prices.map_price is
  'MAP (Advertised) from the price sheet. Reference only: never auto-applied to a line, and not part of any key.';
comment on column public.list_prices.floor_price is
  'Distributor Net from the price sheet. The hard floor checkDiscount refuses to go below (super admins excepted).';

-- Every contractor names the same product differently: Herc calls the H9 "H9G",
-- United Rentals calls it "ECHOBARRIER H9 GREEN". Storing their code next to the
-- price lets a rep match the line against the customer's own purchase order, and
-- makes re-loading a future sheet unambiguous instead of a fresh mapping job.
--
-- NOT part of the upsert key, which stays
-- (hubspot_company_id, sku, currency, valid_from), so it stays editable on an
-- existing row unlike sku, currency and valid_from.
alter table public.contract_prices
  add column if not exists customer_part_number text;

comment on column public.contract_prices.customer_part_number is
  'The contractor''s own part number for this product, e.g. Herc "H9G" or United Rentals "ECHOBARRIER H9 GREEN". Display and reconciliation only; never a lookup key.';
