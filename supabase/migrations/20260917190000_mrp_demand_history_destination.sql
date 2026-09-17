-- Where the factory built it for.
--
-- The factory ledger's sales_person column is not a person on most rows, it is the destination
-- stock pool: "USA Stock", "UK Stock", "French Stock", "OZ Stock", "Canada Stock", "ND Stock" and
-- "External Group Sales". A handful of rows do carry a real salesperson, for direct sales, and
-- those stay null here rather than being guessed.
--
-- This recovers EB-USA's supply from the factory, per product, per month, from July 2020, which is
-- four and a half years earlier than any other source reaches for the Americas.
--
-- 🔴 It is replenishment demand ON the factory BY destination, NOT end-customer demand in that
-- market, and it must never be summed with the market's own sales figures. EB-USA carries both:
-- 40,590 units of factory supply and 29,091 units of its own Xero sales. They are different
-- questions about the same barriers.
alter table public.mrp_demand_history
  add column if not exists destination_org text;

comment on column public.mrp_demand_history.destination_org is
  'For factory rows, the destination stock pool the build was for. Replenishment demand on the factory by destination, not end-customer demand in that market. Null where the source does not say.';

create index if not exists idx_mrp_demand_history_destination
  on public.mrp_demand_history (destination_org, period_month)
  where destination_org is not null;
