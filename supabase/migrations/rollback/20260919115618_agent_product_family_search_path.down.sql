-- Rollback for 20260919115618_agent_product_family_search_path.
--
-- Restores the role-mutable search_path the function had as jack_product_family.
-- Like its sibling rollback this restores a linter warning rather than fixing
-- anything, and exists only so every migration has one.
--
-- Run before 20260919115549_agent_namespace_rename.down.sql, which renames this
-- function away.

alter function public.agent_product_family(text) reset search_path;
