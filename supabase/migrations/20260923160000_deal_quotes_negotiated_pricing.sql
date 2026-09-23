-- APPLIED 2026-09-23 via MCP apply_migration on korylyniwsqtsvzuzydg, before the Hub deploy that uses
-- it. The check only widens, so the Hub already running is unaffected either way. This file is the
-- repo record of what ran. Never db push.
--
-- Negotiated pricing for Jack, the ANZ AI sales agent. Dean, 2026-09-23: "No called with no urgnecy
-- Jack should do list price and if they ask for discount also up to 15% but very urgent need it now
-- allows for urgent pricing".
--
-- So a Jack quote can now be a third kind: a price below list that Jack agreed on the call through
-- the check_offer tool, never more than 15% off list and never under the floor (cost) either. The
-- urgent floor stays exactly as it was, for a caller who needs the barriers now.
--
-- Only the allowed values of pricing_mode change. A negotiated quote carries no accept_by: that
-- deadline belongs to the urgent offer alone, and deal_quotes_accept_by_check already requires it to
-- be null for anything that is not urgent, so that check is left as it is.

begin;

alter table public.deal_quotes drop constraint if exists deal_quotes_pricing_mode_check;
alter table public.deal_quotes add constraint deal_quotes_pricing_mode_check
  check (pricing_mode is null or pricing_mode in ('list', 'urgent', 'negotiated'));

commit;
