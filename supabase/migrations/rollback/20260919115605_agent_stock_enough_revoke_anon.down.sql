-- Rollback for 20260919115605_agent_stock_enough_revoke_anon.
--
-- 🔴 READ THIS BEFORE RUNNING IT. The forward migration closed a real defect:
-- agent_stock_enough was a SECURITY DEFINER function callable by anon over
-- /rest/v1/rpc/. Rolling it back RE-OPENS that. There is no good reason to run
-- this file. It exists because every migration here carries a rollback, and a
-- missing one is indistinguishable from a forgotten one.
--
-- If you are undoing the whole rename, run this first, then
-- 20260919115549_agent_namespace_rename.down.sql, which drops this signature
-- entirely and therefore makes the grants moot anyway.

grant execute on function public.agent_stock_enough(text, numeric, text) to anon;
grant execute on function public.agent_stock_enough(text, numeric, text) to authenticated;
