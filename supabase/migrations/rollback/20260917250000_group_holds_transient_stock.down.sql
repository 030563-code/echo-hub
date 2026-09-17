-- Rollback for 20260917250000_group_holds_transient_stock.sql
--
-- 🔴 Reverting this removes EB-GROUP as a stock-holding organisation, which Dean explicitly said
-- it is: "group should still be a stock holding org it will just appear and then disappear out of
-- the stock". Do not run it because Group's levels look like zeroes. They look like zeroes because
-- it is a transit buffer and that is its resting state.
delete from public.warehouse_stock_levels where warehouse_code = 'EB-GROUP';
delete from public.product_depot_mapping where depot_code = 'EB-GROUP';
