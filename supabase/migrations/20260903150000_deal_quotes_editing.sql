-- Recall and edit a published HubSpot quote.
--
-- Until now a correction meant a SECOND quote object with a second link, and
-- the customer was left holding the first one (deal-quotes-card.tsx said so in
-- its own comment). HubSpot does allow an edit in place: move hs_status back to
-- DRAFT, change the quote, then republish.
--
-- Verified live on portal 3882358 before this was written, because HubSpot's
-- guide does not document it: pulling a quote back to DRAFT CLEARS
-- hs_quote_link, and republishing restores the SAME url byte for byte (checked
-- by sha256 on quotes 42646685547 and 42607881765, both of which have been
-- through a full round trip). So the link already sent to the customer serves
-- the new version, and it is dead only for the seconds the quote sits in DRAFT.

-- 'editing' is a recall in flight: the HubSpot quote is back in DRAFT, its link
-- is dead, and the rep is mid-edit. Deliberately NOT reusing 'draft', which
-- means a generate that never finished. The two need different words on the
-- deal page because they need different recovery: a draft is retried, an
-- editing row is republished.
alter table public.deal_quotes drop constraint deal_quotes_status_check;
alter table public.deal_quotes add constraint deal_quotes_status_check
  check (status in ('draft', 'editing', 'published', 'failed'));

-- Extend the in-flight guard to cover an edit, so a generate and a recall
-- cannot both be live on one deal. Same reasoning as the original index: the
-- builder's submit guard is client state and does not survive a refresh.
drop index if exists deal_quotes_one_in_flight;
create unique index deal_quotes_one_in_flight
  on public.deal_quotes (hubspot_deal_id) where status in ('draft', 'editing');

alter table public.deal_quotes add column if not exists recalled_at timestamptz;
alter table public.deal_quotes add column if not exists edited_at   timestamptz;
alter table public.deal_quotes add column if not exists edit_count  integer not null default 0;

-- The link as it stood before the recall. Two jobs: the republish asserts the
-- restored link matches it (so the day HubSpot stops reissuing the same url is
-- the day we find out, rather than the day a customer reports a dead link), and
-- a republish that fails outright leaves a record of what the customer was
-- actually sent.
alter table public.deal_quotes add column if not exists link_before_edit text;

comment on column public.deal_quotes.link_before_edit is
  'hs_quote_link as it was before a recall. The republish asserts the restored link still equals this.';

-- No grant changes. deal_quotes stays RLS-on with no policy, so it is
-- service-role only and read through the admin client after a TS capability
-- check (the customer_invoices doctrine).
