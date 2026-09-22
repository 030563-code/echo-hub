-- Undo 20260922190000_orderable_needs_an_account.
--
-- 🔴 Running this puts 19,794 individual hire-fleet barriers back into the Bury St Edmunds
-- line-item dropdown (EBH907644, EBH4006754 and so on, one Xero item per physical barrier).
-- The screen becomes unusable for raising a UK purchase order. Do not run it to fix something
-- else.
--
-- If the goal is to make a particular product orderable again, set is_active on that row instead.

update public.product_depot_mapping
set is_active = true, updated_at = now()
where source = 'xero'
  and not is_active
  and not xero_is_archived
  and xero_sales_account_code is null
  and xero_purchase_account_code is null;

do $$
begin
  raise notice 'Sync rows with no account code are orderable again. Re-apply 20260922180000_xero_item_staging.sql to restore the previous commit function.';
end $$;
