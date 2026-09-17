-- Rollback for 20260917230000_demand_stock_shared_vocabulary.sql
--
-- 🔴 Reverting this puts demand and stock back on different keys for UK, France, Group and the
-- factory, so their buffers would show stock against no demand and read permanently green. Only
-- do this alongside reverting the stock consolidation.
create or replace view public.mrp_demand_engine_feed
with (security_invoker = true) as
with org_region as (
  select * from (values
    ('EB-USA', 'NA'), ('EB-CANADA', 'NA'), ('EB-SRO', 'SRO'),
    ('EB-UK', 'UK'), ('EB-FRANCE', 'FR'), ('EB-AUSTRALIA', 'AU'), ('EB-GROUP', 'GRP')
  ) as t(organisation, region)
),
map as (
  select distinct on (c.bom_model_code, c.region)
    c.bom_model_code, c.region, c.sku
  from public.po_product_catalog c
  where c.active and c.bom_model_code is not null
  order by c.bom_model_code, c.region, (c.sku ~* '(ER|USED|REFURB)') asc, c.sku asc
)
select h.event_date, h.organisation, coalesce(m.sku, h.product_model) as sku,
       h.quantity as qty, h.source, h.channel, h.product_model, (m.sku is null) as sku_unmapped
from public.mrp_demand_history h
join org_region o on o.organisation = h.organisation
left join map m on m.bom_model_code = h.product_model and m.region = o.region
where h.product_class = 'BARRIER' and not h.is_suspected_duplicate;

alter table public.product_code_master drop column if exists bom_model_code;
