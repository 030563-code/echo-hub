-- Which HubSpot deals were quoted through the Hub.
--
-- Applied live to korylyniwsqtsvzuzydg via MCP apply_migration on 23 Sep 2026 (recorded there as
-- 20260923111513), after a dry run inside a rolled-back transaction: 22 deals, one row each.
-- This file is the repo record of what ran. Never db push.
--
-- Dean, 23 Sep 2026: "add a little EH echo hub orange logo at the bottom right of each deal on the
-- kanban board so we can see which deals are done through the hub and which are not and also this
-- should be visible somewhere where our CORTEX CSO can pick it up and query when deals are not done
-- through the Hub."
--
-- One definition with two readers: the Hub's deals board (the EH mark on a card) and the CSO's desk
-- pack (cortex-brains cso-brain/scripts/sales-desk-pack.mjs), which reads it with the ops service
-- key the same way its House Clearing check already reads hub_calls. The fact belongs to the Hub,
-- so it is read where it lives and nothing is copied into HubSpot.
--
-- A deal counts when the Hub's quote builder made a quote for it, on either of two records:
--   1. deal_quotes, published or open for editing: every quote the Hub has published since the
--      table arrived on 3 Sep 2026. A draft or a failed publish is not a quote anybody received.
--   2. deals_registry.quote_reference, for the builder's quotes from before that (the Quotes app,
--      December 2025 onwards). The builder mints its own reference, initials then year then a
--      sequence (JR202600012), and keeps whatever reference the row already holds. Something else
--      writes the deal's own HubSpot id into the same column, so a reference that is not the deal
--      id is the builder's. Measured on 23 Sep 2026: 157 rows hold the deal id, 19 hold a builder
--      reference, nothing else.
--
-- The dates come from deal_quotes alone and are null for a quote from before 3 Sep 2026: the
-- registry row's own dates say when the row was made or synced, not when the quote was.
--
-- Read by the server only. security_invoker, so a reader never gets past the tables' own rules, and
-- no grant to anon or authenticated. The Hub reads it with its admin client, and only for the deal
-- ids already on the viewer's board.
create or replace view public.hub_quoted_deals
with (security_invoker = true) as
with published as (
  select q.hubspot_deal_id,
         count(*)::integer as published_quotes,
         min(q.created_at) as first_quoted_at,
         max(q.created_at) as last_quoted_at
  from public.deal_quotes q
  where q.status in ('published', 'editing')
  group by q.hubspot_deal_id
),
builder as (
  select r.hubspot_deal_id::text as hubspot_deal_id,
         btrim(r.quote_reference)::text as quote_reference
  from public.deals_registry r
  where nullif(btrim(r.quote_reference), '') is not null
    and btrim(r.quote_reference) <> btrim(r.hubspot_deal_id)
)
select coalesce(p.hubspot_deal_id, b.hubspot_deal_id) as hubspot_deal_id,
       coalesce(p.published_quotes, 0) as published_quotes,
       p.first_quoted_at,
       p.last_quoted_at,
       b.quote_reference
from published p
full join builder b on b.hubspot_deal_id = p.hubspot_deal_id;

comment on view public.hub_quoted_deals is
  'HubSpot deals whose quote was made in the Hub: a published quote in deal_quotes (since 3 Sep 2026), or a quote reference minted by the quote builder before that. The EH mark on the deals board and the CSO desk pack both read this. Server only.';

revoke all on public.hub_quoted_deals from public, anon, authenticated;
grant select on public.hub_quoted_deals to service_role;
