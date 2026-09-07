-- Reverses 20260907120000_user_page_state.sql. The table holds only UI state,
-- so dropping it loses saved drafts and filters and nothing else: no business
-- record depends on it and nothing references it.
drop table if exists public.user_page_state;
