-- Where each person was, on each page.
--
-- The Hub kept every screen's state in React and nowhere else, so leaving a
-- page threw it away. Open a deal, answer Quote Setup, add three lines, go to
-- Pricing to check a number, come back: Quote Setup asks again and the cart is
-- empty. Same shape of loss on the raise-PO form, the deal wizard, the invoice
-- editor, and every search box and filter on the board pages.
--
-- One row per person per page key holds that page's state as jsonb. Two kinds
-- go in it, and the difference is a UI decision, not a schema one:
--   draft  typed content (a cart, a wizard, a price sheet). Restored with a
--          visible strip and a Start again button, cleared when the work it
--          belongs to completes.
--   view   filters, a search box, a tab, a sort. Restored silently.
--
-- Private per user by RLS, which is the whole access model: there is no
-- capability check anywhere in this feature because a row is only ever its
-- owner's own UI state. Nothing reads it but the person who wrote it, so the
-- service role is not involved and the session client is the only writer.
create table if not exists public.user_page_state (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  page_key   text        not null,
  state      jsonb       not null,
  -- A fingerprint of the server record the state was built on, when there is
  -- one (an invoice's updated_at, the BOM week). Lets a consumer notice that
  -- the world moved on and refuse to restore over it. Null when the page has
  -- nothing underneath it to go stale against.
  base       text,
  updated_at timestamptz not null default now(),
  primary key (user_id, page_key),

  -- Kept in step with PAGE_KEY_RE in src/lib/page-state.ts; a unit test reads
  -- this file and asserts the two are the same pattern, so a key the app
  -- accepts can never be one the database rejects.
  constraint user_page_state_key_format
    check (page_key ~ '^[a-z][a-z0-9-]*(:[A-Za-z0-9_-]+)*$' and length(page_key) <= 160),

  -- A cart or a wizard is a few kilobytes. This is a guard against a page
  -- accidentally persisting something enormous (a product catalogue, a base64
  -- attachment), not a budget anyone should be spending. savePageState refuses
  -- the same size first and says so, so this only ever fires on a bug.
  constraint user_page_state_size
    check (octet_length(state::text) <= 65536)
);

comment on table public.user_page_state is
  'Per-user UI state per page: quote drafts, wizard steps, board filters. Owner-only via RLS, written by savePageState, cleared by clearPageState when the work completes.';
comment on column public.user_page_state.page_key is
  'Page identity, e.g. quote-builder:12345. Never contains a user id: the row is already scoped to one user.';
comment on column public.user_page_state.base is
  'Fingerprint of the underlying server record when the state was saved, so a consumer can detect that it went stale.';

-- No updated_at trigger on purpose. public.set_updated_at() exists in the live
-- database but is declared in no migration in this repo, so depending on it
-- here would bind a new table to undeclared schema. The one writer is
-- savePageState and it sets updated_at itself; the column default covers the
-- insert half of the upsert.

alter table public.user_page_state enable row level security;
revoke all on public.user_page_state from public, anon;
grant select, insert, update, delete on public.user_page_state to authenticated;
-- This project carries a default privilege that hands `authenticated` ALL on
-- every new table in public, and RLS does not restrain TRUNCATE. Take back the
-- three verbs a page never needs, so the policy below is the whole story.
-- (deals_registry, purchase_orders, profiles and user_capabilities all still
-- carry TRUNCATE for authenticated; that predates this table and is Dean's to
-- decide on, so it is reported rather than changed here.)
revoke truncate, trigger, references on public.user_page_state from authenticated;

-- One policy for all four verbs: a person may do anything to their own row and
-- nothing at all to anyone else's. auth.uid() is wrapped in a SELECT so the
-- planner evaluates it once per statement rather than once per row, and
-- user_id is the leading primary-key column, so the check is an index lookup.
drop policy if exists "hub: own page state" on public.user_page_state;
create policy "hub: own page state" on public.user_page_state
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
