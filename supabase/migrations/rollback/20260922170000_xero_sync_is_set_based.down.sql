-- Undo 20260922170000_xero_sync_is_set_based.
--
-- Reverting restores a reconcile that runs one UPDATE per item, which timed out on the UK
-- organisation and silently cost it its refresh. Do not revert this to fix something else.
-- Re-apply 20260922160000_xero_item_codes_are_case_insensitive.sql for the previous body.

do $$
begin
  raise notice 'Nothing to roll back automatically. Re-apply 20260922160000_xero_item_codes_are_case_insensitive.sql for the previous, per-item function body.';
end $$;
