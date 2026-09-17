-- Committed customer orders, from the Hub instead of Xero.
--
-- Dean, 17 Sep 2026: "currently the committed orders in the US is not working
-- since we dont go through Xero anymore and purely through the Hub ... the
-- current accepted quotes in the Hub should go under commited orders in the US
-- rows for Daves report to be correct."
--
-- The daily stock report takes its Committed column from
-- eb_operations.committed_orders, which North America Stock WF1 fills from Xero
-- `Quotes?Status=ACCEPTED`. US quoting moved to the Hub, so no Xero quote is
-- raised any more and that column now reads as though nothing is committed.
--
-- This view is the replacement source. It reuses the Hub's OWN definition of an
-- accepted quote so the figure always agrees with the Accepted Quotes screen: a
-- deal that PASSED THROUGH the Quotation Accepted stage (deal_stage_history),
-- not one currently sitting in it. A deal is in that stage for minutes before
-- moving to Closed Won, so filtering on the current stage loses almost
-- everything. Same reasoning as getAcceptedSinceCutover() in
-- src/app/actions/invoicing/shared.ts.
--
-- Mirrors Xero's semantics for "committed": a Xero quote stays ACCEPTED until
-- it becomes an invoice, so a deal leaves this view once a completed invoice
-- exists. Accepted-then-lost, and deals deliberately held out of the invoicing
-- queue, are excluded too.
--
-- Column names match eb_operations.committed_orders so the report can read
-- either without a change of shape.
create or replace view public.hub_committed_orders as
with accepted as (
  -- '1170409275' is USA SALES Quotation Accepted; '2026-08-26' is the Hub
  -- invoicing cutover. Both mirror src/lib/customer-invoice/constants.ts.
  select h.deal_id, max(h.changed_at) as accepted_at
  from public.deal_stage_history h
  where h.new_status = '1170409275'
    and h.changed_at >= '2026-08-26'
  group by h.deal_id
),
line as (
  select d.hubspot_deal_id, d.deal_name, d.depot_code, a.accepted_at, item
  from accepted a
  join public.deals_registry d on d.hubspot_deal_id = a.deal_id
  cross join lateral jsonb_array_elements(d.line_items_raw) as item
  where d.line_items_raw is not null
    and coalesce(item->>'sku', '') <> ''
    -- Accepted and then LOST is not committed. Every other onward stage,
    -- Closed Won above all, stays committed until it is invoiced.
    and d.deal_status not in (
      'cfbab5be-64fa-4b37-b8f4-95525c980204','602a59e7-219a-4754-bd0a-89b3cf8ca05b',
      '7c7ae5a8-fb7d-455a-bc0f-10fa5f5e0651','1216649',
      'df504eb8-6565-43c4-b388-34d3098ae061','0d461cb5-5ff0-4706-bc88-af1b4268e2c5',
      '00a3dcca-cac4-4122-968f-f5a5f12c7132','closedlost',
      'eb16b938-673a-423b-8caa-8ff6d0c13d69','f7334628-2768-47cc-83a5-498c797009e5',
      '39459184','39449902','41433861')
    and not exists (
      select 1 from public.invoicing_queue_exclusions x
      where x.hubspot_deal_id = d.hubspot_deal_id)
    and not exists (
      select 1 from public.customer_invoices ci
      where ci.hubspot_deal_id = d.hubspot_deal_id and ci.status = 'completed')
)
select
  l.hubspot_deal_id                                        as quote_number,
  l.deal_name                                              as quote_reference,
  l.accepted_at::date                                      as quote_date,
  l.deal_name                                              as customer_name,
  l.item->>'sku'                                           as hubspot_sku_code,
  -- The Hub stamps xero_item_code onto a line when the quote is built, which is
  -- the authoritative answer. The mapping table is the fallback for older lines
  -- that predate that. For a deal carrying no depot, `u` resolves ONLY when the
  -- SKU has exactly one active mapping; it never guesses a depot.
  coalesce(l.item->>'xero_item_code', m.xero_item_code, u.xero_item_code) as item_code,
  coalesce(l.item->>'xero_org', m.xero_org, u.xero_org)    as xero_org,
  coalesce(l.item->>'xero_item_description', l.item->>'name') as description,
  (l.item->>'quantity')::numeric                           as quantity,
  (l.item->>'unit_price')::numeric                         as unit_price,
  coalesce(l.depot_code, m.depot_code, u.depot_code)       as depot_code,
  l.accepted_at                                            as accepted_at
from line l
left join public.product_depot_mapping m
  on m.hubspot_sku_code = l.item->>'sku'
 and m.depot_code = l.depot_code
 and m.is_active
left join lateral (
  select min(p.xero_item_code) as xero_item_code,
         min(p.xero_org)       as xero_org,
         min(p.depot_code)     as depot_code
  from public.product_depot_mapping p
  where p.hubspot_sku_code = l.item->>'sku' and p.is_active
  having count(distinct p.xero_item_code) = 1
) u on l.depot_code is null;

comment on view public.hub_committed_orders is
  'Committed customer orders derived from the Hub accepted quotes, replacing the Xero Quotes?Status=ACCEPTED source that stopped producing US rows when quoting moved off Xero. Same column names as eb_operations.committed_orders. A deal leaves the view once it has a completed invoice, matching how a Xero quote stops being ACCEPTED once invoiced.';

revoke all on public.hub_committed_orders from public, anon;
grant select on public.hub_committed_orders to authenticated, service_role;
