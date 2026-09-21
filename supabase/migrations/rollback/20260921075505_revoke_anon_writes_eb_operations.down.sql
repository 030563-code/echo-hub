-- Rollback for 20260921075505_revoke_anon_writes_eb_operations.
--
-- This restores the state as it stood on 21 September 2026 before the revoke: anon and
-- authenticated able to TRUNCATE four eb_operations tables, anon able to DELETE and UPDATE them,
-- and a blanket true/true read-write policy on po_lifecycle. Do not run it to "fix" a broken
-- app. If something turns out to need one of these privileges, grant that one privilege to that
-- one role on that one table instead, with a policy that names the rows it may touch.

grant truncate on
  eb_operations.po_lifecycle,
  eb_operations.pick_lists,
  eb_operations.pick_list_items,
  eb_operations.pick_list_config
to anon, authenticated;

grant delete, update on
  eb_operations.po_lifecycle,
  eb_operations.pick_lists,
  eb_operations.pick_list_items,
  eb_operations.pick_list_config
to anon;

create policy "Allow anon all" on eb_operations.po_lifecycle
  for all to anon using (true) with check (true);
