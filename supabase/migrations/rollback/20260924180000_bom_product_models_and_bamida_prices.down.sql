-- Rollback of 20260924180000_bom_product_models_and_bamida_prices.sql.
-- Every product code goes back to the model the product tables give it, and every Bamida price
-- back to the sheet's. Orders already approved keep the cost they froze. The audit rows in
-- bom_edit_log stay, as the record of what was chosen.
drop table if exists public.bom_bamida_price;
drop table if exists public.bom_product_model;
