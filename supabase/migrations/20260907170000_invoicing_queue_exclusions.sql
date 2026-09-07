-- Deals that must not appear in the Accepted Quotes queue, with the reason.
--
-- The queue is driven by deal_stage_history rather than the deal's current
-- stage, on purpose: a deal only sits in Quotation Accepted for minutes before
-- moving to Closed Won, and filtering on the current stage made every won deal
-- vanish. The side effect is that a deal invoiced OUTSIDE the Hub still shows
-- up, because passing through the stage is all it takes, and voiding a Hub
-- invoice raised against it by mistake puts it straight back.
--
-- Sonco PO #106932 (deal 64429492377) is the case that found this: invoiced in
-- August in the old system, accepted in HubSpot on 1 September, so it queued
-- here with nothing to do.
--
-- Reversible by design. Nothing is deleted, the reason is recorded, and the
-- Accepted page lists what has been set aside with an Undo next to it.
create table if not exists public.invoicing_queue_exclusions (
  hubspot_deal_id text        primary key,
  reason          text        not null,
  excluded_by     uuid        references auth.users (id) on delete set null,
  excluded_at     timestamptz not null default now(),
  constraint invoicing_queue_exclusions_reason_len check (length(reason) between 1 and 300)
);

comment on table public.invoicing_queue_exclusions is
  'Deals held out of the Accepted Quotes queue (already invoiced elsewhere, raised in error). Written only by the invoicing server actions, which check invoicing.manage.';

alter table public.invoicing_queue_exclusions enable row level security;

-- No PostgREST access at all. The queue and its actions use the service-role
-- client and check invoicing.manage themselves, so nothing needs to reach this
-- table from a browser. Revoked explicitly because this project grants
-- authenticated TRUNCATE, TRIGGER and REFERENCES on every new table in public
-- by default, and RLS does not restrain TRUNCATE.
revoke all on public.invoicing_queue_exclusions from public, anon, authenticated;
