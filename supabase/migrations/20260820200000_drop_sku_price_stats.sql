-- Dean's call 2026-08-20: HubSpot prices are the ground truth — the app must
-- not derive price estimates from recent quotes. Drops get_sku_price_stats,
-- which fed the (reverted) quote-builder typical-price guard. Both the create
-- (sku_price_stats_function / sku_price_stats_two_regime) and this drop were
-- applied live via MCP; the create's repo mirror was removed in the revert.
drop function if exists public.get_sku_price_stats(text[]);
