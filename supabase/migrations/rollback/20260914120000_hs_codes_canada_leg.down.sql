-- Rollback for 20260914120000_hs_codes_canada_leg.sql.
-- Run it as ONE transaction: through the Supabase SQL editor or MCP execute_sql
-- (one batch), or with psql --single-transaction -f.
--
-- Deletes only what the migration inserted: the GROUP_TO_CANADA prices, the
-- GROUP_TO_CANADA composition rules, and the EB-CANADA entity. The HS codes
-- typed for the Canada leg are not the migration's rows and are left alone, but
-- once the app no longer knows that leg nothing reads them. Void any Group to
-- Canada invoice first: its buyer, EB-CANADA, is deleted here. Canada prices
-- edited after the migration are deleted with the rest; export them first if they
-- matter.

-- The app issues and edits drafts through these two functions, so roll the app
-- back first.
drop function if exists public.hub_replace_commercial_invoice_lines(uuid, jsonb, jsonb);
drop function if exists public.hub_issue_commercial_invoice(uuid);

alter table public.product_hs_codes drop constraint if exists product_hs_codes_hs_code_format;
alter table public.product_hs_codes drop constraint if exists product_hs_codes_leg_check;

alter table public.product_hs_codes alter column leg set default '*';

delete from public.invoice_composition_rules
where leg = 'GROUP_TO_CANADA'
  and note = 'Mirrors the Group to USA rule for Group to Canada. CONFIRM it applies to Canada.';

delete from public.intercompany_prices where leg = 'GROUP_TO_CANADA';

delete from public.entities where code = 'EB-CANADA';
