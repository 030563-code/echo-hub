-- NOT APPLIED. Needs Dean's go-ahead, and it MUST land in the same window as
-- the Jack cutover: /api/agent/quote writes these columns on every quote it
-- raises, so the Hub deploy and this file go together. Apply via MCP
-- apply_migration on korylyniwsqtsvzuzydg, then move this file up into
-- supabase/migrations/. Never db push.
--
-- Urgent floor pricing for Jack, the ANZ AI sales agent (Dean, 2026-09-14).
--
-- Jack opens at list_prices.unit_price. Only when the caller says the job is
-- urgent may he offer list_prices.floor_price, and only with a 24 hour
-- acceptance condition attached. If the window closes with no acceptance the
-- quote is reissued at the standard price. Three facts have to survive on the
-- row for any of that to be checkable afterwards: which price this quote was,
-- when the offer closes, and which urgent quote a reissue replaces.
--
-- Kept on deal_quotes rather than in a table of its own because they describe
-- ONE quote and nothing reads them without reading the quote. Every column is
-- nullable and nothing is backfilled: a row written by a rep, or written
-- before this ran, carries null and reads as ordinary list pricing. That is
-- also why the Hub omits the columns entirely unless the agent raised the
-- quote, so a rep's Generate does not depend on this migration existing.
--
-- deal_quotes is service-role only (RLS on, no policies, no grant to anon or
-- authenticated, per 20260903000000), so there are no grants to extend here.

begin;

alter table public.deal_quotes add column if not exists pricing_mode text;
alter table public.deal_quotes add column if not exists accept_by    timestamptz;
alter table public.deal_quotes add column if not exists reissue_of   uuid;
alter table public.deal_quotes add column if not exists urgency_note text;

-- Null means list. Spelling it out for an agent quote anyway (the Hub writes
-- 'list' explicitly) so the reissue check can read the newest Jack row and see
-- what it was, rather than infer it from an absence.
alter table public.deal_quotes drop constraint if exists deal_quotes_pricing_mode_check;
alter table public.deal_quotes add constraint deal_quotes_pricing_mode_check
  check (pricing_mode is null or pricing_mode in ('list', 'urgent'));

-- An acceptance deadline only means anything on an urgent quote, and an urgent
-- quote without one cannot be reissued or chased. Both directions, so neither
-- half can be written on its own.
alter table public.deal_quotes drop constraint if exists deal_quotes_accept_by_check;
alter table public.deal_quotes add constraint deal_quotes_accept_by_check
  check ((pricing_mode = 'urgent') = (accept_by is not null));

-- What the caller said made the job urgent, as the agent heard it. The audit of
-- why a floor price was offered. Never printed on the quote and never emailed,
-- and capped at the same 200 characters the route accepts.
alter table public.deal_quotes drop constraint if exists deal_quotes_urgency_note_check;
alter table public.deal_quotes add constraint deal_quotes_urgency_note_check
  check (urgency_note is null or length(urgency_note) <= 200);

-- A reissue points at the urgent quote it replaces. ON DELETE SET NULL rather
-- than CASCADE: deleting the old quote must never delete the live one the
-- customer is holding.
alter table public.deal_quotes drop constraint if exists deal_quotes_reissue_of_fkey;
alter table public.deal_quotes add constraint deal_quotes_reissue_of_fkey
  foreign key (reissue_of) references public.deal_quotes(id) on delete set null;

-- The urgent cap reads "published urgent quotes on this deal in 30 days".
create index if not exists deal_quotes_urgent_idx
  on public.deal_quotes (hubspot_deal_id, created_at desc)
  where pricing_mode = 'urgent';

-- Small and sparse: it exists so the foreign key does not force a sequential
-- scan of deal_quotes on every delete.
create index if not exists deal_quotes_reissue_of_idx
  on public.deal_quotes (reissue_of)
  where reissue_of is not null;

comment on column public.deal_quotes.pricing_mode is
  'list or urgent, for a quote raised by Jack (the ANZ AI sales agent). Null on every quote a person raises, and read as list.';
comment on column public.deal_quotes.accept_by is
  'When an urgent-priced quote stops holding its floor price: created plus 24 hours. Set if and only if pricing_mode is urgent.';
comment on column public.deal_quotes.reissue_of is
  'The lapsed urgent deal_quotes row this quote replaces at standard prices. At most one reissue per urgent quote, enforced by the agent route.';
comment on column public.deal_quotes.urgency_note is
  'What the caller said made the job urgent. Audit only: never printed on the quote and never emailed.';

commit;
