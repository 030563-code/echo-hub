-- Undo 20260922150000_xero_sync_reports_flagged.
--
-- There is nothing to undo that is worth undoing. This migration only added a counter to a
-- function's return value and tightened who may call two functions. Reverting it would restore a
-- reconcile that silently says "retired: 0" while flagging rows nobody will look at, and would
-- hand EXECUTE back to anon on a function that reads a table anon cannot read.
--
-- If you genuinely need the previous shape, re-apply 20260922140000, which carries it.

do $$
begin
  raise notice 'Nothing to roll back. Re-apply 20260922140000_xero_items_in_depot_mapping.sql to restore the earlier function body.';
end $$;
