-- The engine speaks SKUs (EBH9NA); the demand history speaks product models (H9). This is the join.
--
-- A view rather than a column on the history table, because the mapping is a present-day fact
-- about the catalogue while the history is a record of what happened. Remapping a SKU must not
-- rewrite history.
--
-- 🔴 An unmapped model falls through as its own model code with sku_unmapped = true rather than
-- being dropped. Demand that silently disappears because nobody maintained a mapping is the worst
-- failure mode this engine has: the buffer just looks calm.
create or replace view public.mrp_demand_engine_feed
with (security_invoker = true) as
with org_region as (
  select * from (values
    ('EB-USA', 'NA'),
    ('EB-CANADA', 'NA'),
    ('EB-SRO', 'SRO'),
    ('EB-UK', 'UK'),
    ('EB-FRANCE', 'FR'),
    ('EB-AUSTRALIA', 'AU'),
    ('EB-GROUP', 'GRP')
  ) as t(organisation, region)
),
map as (
  -- One SKU per (model, region). Where a model has more than one spelling the plain one wins: H9
  -- in North America resolves to EBH9NA, not EBH9ERNA, because the ex-rental SKU is a disposal
  -- channel and sizing a manufacturing buffer on it would be wrong.
  select distinct on (c.bom_model_code, c.region)
    c.bom_model_code,
    c.region,
    c.sku
  from public.po_product_catalog c
  where c.active
    and c.bom_model_code is not null
  order by
    c.bom_model_code,
    c.region,
    (c.sku ~* '(ER|USED|REFURB)') asc,
    c.sku asc
)
select
  h.event_date,
  h.organisation,
  coalesce(m.sku, h.product_model) as sku,
  h.quantity as qty,
  h.source,
  h.channel,
  h.product_model,
  (m.sku is null) as sku_unmapped
from public.mrp_demand_history h
join org_region o on o.organisation = h.organisation
left join map m
  on m.bom_model_code = h.product_model
 and m.region = o.region
where h.product_class = 'BARRIER'
  and not h.is_suspected_duplicate;

comment on view public.mrp_demand_engine_feed is
  'The Stock Prediction Engine demand feed: mrp_demand_history resolved from product model to the organisation SKU, barriers only, duplicates and ex-fleet disposals excluded. sku_unmapped flags demand whose model has no SKU in po_product_catalog for that region, which falls through under its model code rather than vanishing.';

revoke all on public.mrp_demand_engine_feed from public, anon;
grant select on public.mrp_demand_engine_feed to authenticated, service_role;
