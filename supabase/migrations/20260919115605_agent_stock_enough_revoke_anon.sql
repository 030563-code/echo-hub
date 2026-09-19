-- APPLIED 2026-09-19 via MCP apply_migration on korylyniwsqtsvzuzydg as version
-- 20260919115605. This file is the repo record of what ran. Never db push.
--
-- A defect introduced by the rename migration, caught by checking pg_proc
-- afterwards rather than by reading the SQL.
--
-- agent_stock_enough(text, numeric, text) is a genuinely NEW function: the
-- rename produced the two-argument form, and the region parameter made a new
-- signature. New functions in public inherit Supabase's default privileges,
-- which grant EXECUTE to anon and authenticated. The rename migration's
-- `revoke all on function ... from public` did NOT undo that, because revoking
-- from the PUBLIC pseudo-role does not touch an explicit grant to a named role.
--
-- So it sat as a SECURITY DEFINER function callable by anon over
-- /rest/v1/rpc/agent_stock_enough. Its blast radius was small by design (it
-- answers yes, no or unknown and never a figure), but every sibling is
-- service_role only and an anon-callable SECURITY DEFINER function is exactly
-- the class of defect this project has shipped before.
--
-- Verified after: all six agent_* functions now read
-- {postgres=X/postgres,service_role=X/postgres}, and none of them appears in the
-- advisor's anon or authenticated SECURITY DEFINER findings.

revoke execute on function public.agent_stock_enough(text, numeric, text) from anon;
revoke execute on function public.agent_stock_enough(text, numeric, text) from authenticated;
revoke execute on function public.agent_stock_enough(text, numeric, text) from public;
grant  execute on function public.agent_stock_enough(text, numeric, text) to service_role;
