-- Reverses 20260904100000_pricing_tiers_and_part_numbers.sql.
--
-- Both columns are additive and nullable, and nothing keys on either, so
-- dropping them cannot orphan a row. What is lost is the MAP tier and every
-- contractor part number, which would have to be reloaded from the sheet.
alter table public.contract_prices drop column if exists customer_part_number;
alter table public.list_prices drop column if exists map_price;
