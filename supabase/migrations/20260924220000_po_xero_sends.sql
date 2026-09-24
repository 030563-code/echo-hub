-- What happened when the Hub handed an approved purchase order leg to Xero.
--
-- Approving a Depot or Group leg posts it to n8n workflow Fz7xXgifva5n548u, which creates the
-- authorised Xero purchase order and writes xero_po_id back onto the leg. Until now a post that
-- failed left no trace beyond a toast, and nothing could send it again, because
-- hub_approve_po_leg refuses a second approval. This table is the trace, and it is what lets
-- "Send to Xero again" run safely.
--
-- One row per leg, written only by the Hub's server with the service role:
--   attempts            how many times the Hub has posted this leg: the approval, then each retry
--   last_attempt_at     when the last post was made, and last_attempt_by_uid who made it
--   last_outcome        accepted (n8n answered 2xx), failed (a refusal, no answer at all, or no
--                       webhook configured) or timed_out (no answer in time, so n8n may still
--                       have finished)
--   last_error          the plain reason for a failed or timed-out post
--   claimed_at          a "Send to Xero again" in flight, so two approvers cannot send at once
--   sandbox_at          the leg was approved in the staging sandbox, which never posts to n8n.
--                       Staging shares this database, so production has to be able to tell.
--
-- A table and not columns on purchase_orders, on purpose: writing here fires none of the
-- purchase_orders triggers, and whole purchase_orders rows are handed to the browser by the
-- board. No foreign key either: one would add internal triggers to purchase_orders and
-- auth.users, and this migration changes nothing that already exists. A row for a deleted leg
-- is never read, because every reader looks rows up by the ids of legs it already holds.

create table public.po_xero_sends (
  po_id               uuid primary key,
  attempts            integer not null default 0 check (attempts >= 0),
  last_attempt_at     timestamptz,
  last_attempt_by_uid uuid,
  last_outcome        text check (last_outcome in ('accepted', 'failed', 'timed_out')),
  last_error          text check (last_error is null or length(btrim(last_error)) between 1 and 500),
  claimed_at          timestamptz,
  sandbox_at          timestamptz,
  created_at          timestamptz not null default now(),
  -- An accepted post carries no error; a failed or timed-out one always says why.
  constraint po_xero_sends_outcome_has_reason check (
    (last_outcome is null and last_error is null)
    or (last_outcome = 'accepted' and last_error is null)
    or (last_outcome in ('failed', 'timed_out') and last_error is not null)
  )
);

comment on table public.po_xero_sends is
  'One row per purchase order leg the Hub has handed to Xero through n8n: attempts, the last outcome and why, a retry claim, and whether it was approved in the staging sandbox. Service role only. See src/lib/po-xero-send.ts.';

-- service_role is revoked too before its grant, because Supabase's default privileges would
-- otherwise also hand it TRUNCATE, TRIGGER and REFERENCES, which nothing here needs.
alter table public.po_xero_sends enable row level security;
revoke all on public.po_xero_sends from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.po_xero_sends to service_role;

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'po_xero_sends' and rowsecurity) then
    raise exception 'row level security is off on po_xero_sends';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'po_xero_sends' and grantee in ('anon', 'authenticated', 'PUBLIC')
  ) then
    raise exception 'anon, authenticated or public hold grants on po_xero_sends';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'po_xero_sends' and grantee = 'service_role'
      and privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'service_role holds more than select, insert, update and delete on po_xero_sends';
  end if;
end $$;
