-- Undo 20260923120000_hub_quoted_deals.
--
-- Drops the view only. Both records it reads (deal_quotes and deals_registry.quote_reference) are
-- untouched. Without it the deals board shows no EH marks and says it could not check, and the
-- CSO's desk pack reports the Hub as unreadable rather than every quote as made elsewhere.
drop view if exists public.hub_quoted_deals;
