-- Rollback for pending/20260914161000_deal_quotes_agent_pricing.sql.
-- Run as ONE transaction (MCP execute_sql in one batch, or psql
-- --single-transaction -f).
--
-- DROPS the four columns and everything written in them: which Jack quotes
-- were urgent, when each offer closed, which quote reissued which, and why a
-- floor price was offered at all. Nothing else reads them, so no other table
-- loses anything, but the discount audit is gone and cannot be rebuilt from
-- the quote itself.
--
-- Roll the Hub back at the same time. /api/agent/quote sends these columns on
-- every quote it raises, so with them dropped an agent quote fails at the
-- insert, before any HubSpot write. A quote raised by a rep is unaffected in
-- both directions: the Hub omits the columns entirely for a person.

begin;

drop index if exists public.deal_quotes_urgent_idx;
drop index if exists public.deal_quotes_reissue_of_idx;

alter table public.deal_quotes drop constraint if exists deal_quotes_reissue_of_fkey;
alter table public.deal_quotes drop constraint if exists deal_quotes_urgency_note_check;
alter table public.deal_quotes drop constraint if exists deal_quotes_accept_by_check;
alter table public.deal_quotes drop constraint if exists deal_quotes_pricing_mode_check;

alter table public.deal_quotes drop column if exists urgency_note;
alter table public.deal_quotes drop column if exists reissue_of;
alter table public.deal_quotes drop column if exists accept_by;
alter table public.deal_quotes drop column if exists pricing_mode;

commit;
