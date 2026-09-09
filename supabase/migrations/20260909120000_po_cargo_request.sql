-- The shipment request that goes to Cargo Partner, held for approval.
--
-- Dean, 9 Sep 2026: there must be an approval step before anything reaches the
-- forwarder, showing the request that is about to go out with every field
-- editable. Bamida press "Manufacturing finished"; that is a factory telling us
-- the barriers exist, not a decision to book freight. So finishing now DRAFTS
-- this row and somebody at Echo Barrier reads it, fixes what is wrong, and
-- releases it.
--
-- `request` holds the editable draft, not the webhook body. The body is
-- assembled from this row at send time so the test-recipient switch and the
-- staging kill switch still decide who a released request actually reaches.
--
-- sent_at is the one-shot claim, exactly like po_manufacturing.finished_at and
-- po_manufacturing.sent_at: it moves off null in a single conditional update,
-- so a double click cannot ask a forwarder twice for the same container.
create table if not exists public.po_cargo_request (
  po_id uuid primary key references public.purchase_orders(id) on delete cascade,
  request jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  sent_at timestamptz,
  sent_by uuid,
  sent_to text[],
  sent_was_test boolean
);

comment on table public.po_cargo_request is
  'One shipment request per manufacturing order, drafted when Bamida finish and released by a person at Echo Barrier. Email only: nothing here writes to the Cargo Partner API.';
comment on column public.po_cargo_request.request is
  'The editable draft. The webhook body is built from this at send time so the email test switch cannot be bypassed by a stored address.';
comment on column public.po_cargo_request.sent_at is
  'One-shot claim. Set by a conditional update where it is null, so a container is never requested twice.';

-- Served by the app with the service role, never by PostgREST. RLS does not
-- restrain TRUNCATE and this project grants authenticated TRUNCATE on every new
-- table in public by default, so the grants go rather than being narrowed.
alter table public.po_cargo_request enable row level security;
revoke all on public.po_cargo_request from public, anon, authenticated;
