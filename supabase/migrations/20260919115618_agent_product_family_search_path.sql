-- APPLIED 2026-09-19 via MCP apply_migration on korylyniwsqtsvzuzydg as version
-- 20260919115618. This file is the repo record of what ran. Never db push.
--
-- The Supabase advisor flags public.agent_product_family as having a role
-- mutable search_path. It arrived that way as jack_product_family, whose
-- proconfig was null, so this is pre-existing rather than introduced by the
-- rename. It is IMMUTABLE and not SECURITY DEFINER, so the exposure on its own
-- is negligible, but it now sits in the agent_ namespace where every sibling
-- pins its search_path, and leaving a known warning on a function this session
-- just renamed is worse than the one line it takes to close.

alter function public.agent_product_family(text) set search_path = public;
