-- Rollback of 20260924235000_quote_sent_check.sql.
-- Deals already moved stay at Quotation sent in HubSpot: HubSpot's own stage history keeps the record
-- of each move. Stop the n8n schedule that calls /api/quotes/detect-sent before running this.
drop table if exists public.quote_sent_moves;
drop table if exists public.quote_sent_check_runs;
