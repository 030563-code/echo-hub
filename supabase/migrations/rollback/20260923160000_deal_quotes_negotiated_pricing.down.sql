-- Rollback for 20260923160000_deal_quotes_negotiated_pricing.sql.
-- Run as ONE transaction (MCP execute_sql in one batch, or psql --single-transaction -f).
--
-- Fails, on purpose, while any row is negotiated: the narrower check cannot be added over one. Those
-- are real published quotes, so decide what they become before rolling back, and roll the Hub back
-- at the same time, because it writes 'negotiated' on every such quote.

begin;

alter table public.deal_quotes drop constraint if exists deal_quotes_pricing_mode_check;
alter table public.deal_quotes add constraint deal_quotes_pricing_mode_check
  check (pricing_mode is null or pricing_mode in ('list', 'urgent'));

commit;
