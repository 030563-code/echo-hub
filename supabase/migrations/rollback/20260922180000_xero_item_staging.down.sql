-- Undo 20260922180000_xero_item_staging.
--
-- Reverting removes the only path that can reconcile an organisation larger than roughly a
-- thousand items. The UK Xero organisation has 19,942, so after this the hourly sync will refresh
-- six organisations and lose the seventh to a statement timeout, which is what it did before.
--
-- It does NOT undo the rows already created, and it does not switch anything back on.
-- sync_xero_items is left in place; it is still the single-request path.

drop function if exists public.xero_items_commit(text, text);
drop function if exists public.xero_items_stage(text, text, jsonb);
drop table if exists public.xero_item_stage;

do $$
begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='xero_item_stage') then
    raise exception 'xero_item_stage survived the rollback';
  end if;
end $$;
