-- Rollback for 20260903000000_pricing_and_deal_quotes.sql.
--
-- Drops in reverse dependency order. Policies and indexes go with their tables.
-- Nothing here touches deals_registry, which the forward migration also leaves
-- alone.

drop table if exists public.deal_quotes;
drop table if exists public.pricing_change_log;
drop table if exists public.rep_discount_caps;
drop table if exists public.contract_prices;
drop table if exists public.list_prices;
drop table if exists public.contractors;

-- Cascades to any user_capabilities rows granting these two keys, which is the
-- intent: with the module gone, a stale grant is a key that resolves to nothing.
delete from public.capabilities where key in ('pricing.view', 'pricing.manage');
