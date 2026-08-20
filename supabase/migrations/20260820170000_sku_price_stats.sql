-- Typical-price statistics per SKU, computed from the caller's own visible
-- quote history (SECURITY INVOKER: deals_registry RLS scopes the rows to the
-- caller's region + capability, so a US rep gets US prices).
-- ALREADY APPLIED LIVE via MCP apply_migration (sku_price_stats_function, then sku_price_stats_two_regime) on
-- korylyniwsqtsvzuzydg — this file is the repo mirror. Never `db push`.
--
-- Why: the HubSpot product library holds $1 placeholder prices on the NA
-- products (every price property), so the quote builder pre-filled $1 and
-- reps have already shipped $1 H9 lines (median real price $185). These stats
-- feed sane defaults, an inline warning, and a server-side low-price gate.
create or replace function public.get_sku_price_stats(p_skus text[])
returns table (sku text, sample_count bigint, median_price numeric)
language sql
security invoker
set search_path = public, pg_temp
as $$
  with lines as (
    select
      e->>'sku' as sku,
      (e->>'unit_price')::numeric as unit_price
    from public.deals_registry d
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(d.line_items_raw) = 'array'
           then d.line_items_raw else '[]'::jsonb end
    ) e
    where e->>'sku' = any(p_skus)
      and (e->>'unit_price') ~ '^[0-9]+(\.[0-9]+)?$'
  ),
  -- Two-regime median: a blanket "exclude <= $5" filter would erase
  -- legitimately cheap SKUs (bungees are $0.50 on every real line, hooks
  -- $1.50). The raw median decides: only real-priced products (> $20) have
  -- their <= $5 lines treated as placeholder mistakes and excluded.
  raw_stats as (
    select sku,
           percentile_cont(0.5) within group (order by unit_price) as raw_median
    from lines
    group by sku
  ),
  qualified as (
    select l.sku, l.unit_price
    from lines l
    join raw_stats r on r.sku = l.sku
    where r.raw_median <= 20 or l.unit_price > 5
  )
  select sku, count(*) as sample_count,
         percentile_cont(0.5) within group (order by unit_price) as median_price
  from qualified
  group by sku
  having count(*) >= 5
$$;

revoke execute on function public.get_sku_price_stats(text[]) from public, anon;
grant execute on function public.get_sku_price_stats(text[]) to authenticated, service_role;
