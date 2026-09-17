-- Demand and stock finally share a key, per organisation.
--
-- The stock consolidation (20260917210000, 20260917220000) left the Hub speaking two languages.
-- UK stock is keyed on product_code_master.internal_sku ('EBH9'); UK demand fell through
-- mrp_demand_engine_feed under its product model ('H9'), because po_product_catalog only carries
-- NA and SRO regions. A join between them returned ZERO rows. A UK buffer would have shown stock
-- against no demand and read permanently green, which is worse than showing nothing.
--
-- Three vocabularies actually exist, and the resolution order per organisation follows its STOCK,
-- not its geography:
--   NA      EBH9NA, BUNNA, HKNA. US-BAL, US-SBD, CA-HAM, and EB-SRO because the factory count was
--           loaded that way.
--   SRO     EBH10JAPSK, EBH9JAPSK. The two Japan products, which only the factory makes.
--   MASTER  EBH9, EBH10, DBRT. internal_sku, which the synced UK, France and Group rows use.

alter table public.product_code_master
  add column if not exists bom_model_code text;

comment on column public.product_code_master.bom_model_code is
  'The product model as the demand history spells it (H9, H10, dB-RT). Joins mrp_demand_history.product_model to this row so demand and stock share a key outside North America. Same meaning as po_product_catalog.bom_model_code.';

update public.product_code_master set bom_model_code = v.model
from (values
  ('EBH9', 'H9'), ('EBH8', 'H8'), ('EBH10', 'H10'),
  ('EBH10HERC', 'H10Herc'), ('EBH10JAP', 'H10Japan'), ('EBH9JAP', 'H9Japan'),
  ('EBH9X', 'H9X'), ('EBH9W', 'H9W'),
  ('EU3.5', 'EU3.5'), ('DBRT', 'dB-RT'), ('DBRS', 'dB-RS'),
  ('NDS', 'NoiseDefender'), ('COMP', 'CSCompact'), ('FSCS', 'CSFullSize'),
  ('V1', 'V1'), ('V2', 'V2'), ('M1', 'M1'), ('HERAS', 'HERAS')
) as v(sku, model)
where public.product_code_master.internal_sku = v.sku;

-- 🔴 HT3.5 is deliberately NOT mapped. product_code_master has one row, internal_sku 'EU3.5',
-- whose code_uk is '01-HT3.5S', so the master already conflates two products the demand data
-- treats separately (tp_barrier_factors carries EU3.5 and HT3.5 as distinct options, both at H9
-- equivalent 3). Mapping HT3.5 demand onto EU3.5 stock would bury that. It needs a product
-- decision, not a guess, so HT3.5 demand stays unresolved and visible.

create or replace view public.mrp_demand_engine_feed
with (security_invoker = true) as
with org_catalog as (
  select * from (values
    ('EB-USA',       'NA',  null),
    ('EB-CANADA',    'NA',  null),
    ('EB-SRO',       'SRO', 'NA'),
    ('EB-UK',        null,  null),
    ('EB-FRANCE',    null,  null),
    ('EB-AUSTRALIA', null,  null),
    ('EB-GROUP',     null,  null)
  ) as t(organisation, region1, region2)
),
cat as (
  select distinct on (c.bom_model_code, c.region)
    c.bom_model_code, c.region, c.sku
  from public.po_product_catalog c
  where c.active and c.bom_model_code is not null
  order by c.bom_model_code, c.region, (c.sku ~* '(ER|USED|REFURB)') asc, c.sku asc
),
master_map as (
  select bom_model_code, internal_sku
  from public.product_code_master
  where is_active and bom_model_code is not null
)
select
  h.event_date,
  h.organisation,
  coalesce(c1.sku, c2.sku, mm.internal_sku, h.product_model) as sku,
  h.quantity as qty,
  h.source,
  h.channel,
  h.product_model,
  (c1.sku is null and c2.sku is null and mm.internal_sku is null) as sku_unmapped
from public.mrp_demand_history h
join org_catalog o on o.organisation = h.organisation
left join cat c1 on c1.bom_model_code = h.product_model and c1.region = o.region1
left join cat c2 on c2.bom_model_code = h.product_model and c2.region = o.region2
left join master_map mm on mm.bom_model_code = h.product_model
where h.product_class = 'BARRIER'
  and not h.is_suspected_duplicate;

comment on view public.mrp_demand_engine_feed is
  'The Stock Prediction Engine demand feed: mrp_demand_history resolved from product model to the SKU vocabulary that organisation''s STOCK is keyed on, barriers only, duplicates and ex-fleet excluded. sku_unmapped flags demand no route could resolve.';

revoke all on public.mrp_demand_engine_feed from public, anon;
grant select on public.mrp_demand_engine_feed to authenticated, service_role;
