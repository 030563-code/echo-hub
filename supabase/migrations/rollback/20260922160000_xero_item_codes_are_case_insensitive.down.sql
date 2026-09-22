-- Undo 20260922160000_xero_item_codes_are_case_insensitive.
--
-- Reverting restores a byte-for-byte comparison of Xero item codes, which flags a product as
-- missing from Xero when the only difference is capitalisation. France's Hooks is the known case.
-- Re-apply 20260922150000_xero_sync_reports_flagged.sql to restore the previous function body.

do $$
begin
  raise notice 'Nothing to roll back automatically. Re-apply 20260922150000_xero_sync_reports_flagged.sql for the previous, case-sensitive function body.';
end $$;
