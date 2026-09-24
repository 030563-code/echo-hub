-- The Hub moves a deal to Quotation sent once HubSpot has logged the quote link going out by email.
--
-- Dean, 24 Sep 2026: "we notice that the sales people dont move their deals from quotation requestion
-- to quotation sent. The rule should probably be that if we can detect that the quote url has gone out
-- via email automatically set it to quotation sent because hubspot doesnt do it themselves and the
-- sales reps send out emails via their personal gmail".
--
-- quote_sent_check_runs  one row per run of the check: the window of logged emails it read, what it
--                        found and what it did. mode 'move' is the half-hourly schedule (POST
--                        /api/quotes/detect-sent); each starts where the last clean one ended, less an
--                        hour, so a missed or failed run loses nothing. 'report' moves nothing.
--                        'backfill' is a one-off catch-up over an older window: it moves, but never
--                        takes part in the schedule's chain.
-- quote_sent_moves       one row per deal a run acted on, or would have in a report run: the email and
--                        the quote that prove the send, and what happened. The deal page reads it to say
--                        why a deal moved.
--
-- Service role only, like deal_quotes: the route and the deal page reach it through the admin client
-- after their own checks.

create table if not exists public.quote_sent_check_runs (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('move', 'report', 'backfill')),
  window_from timestamptz not null,
  window_to timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  emails_read integer not null default 0,
  deals_checked integer not null default 0,
  moved integer not null default 0,
  would_move integer not null default 0,
  failed integer not null default 0,
  notes text[] not null default '{}',
  error text,
  constraint quote_sent_check_runs_window check (window_to > window_from)
);

comment on table public.quote_sent_check_runs is
  'One row per run of the Hub''s quote-sent check (POST /api/quotes/detect-sent). Scheduled runs chain their windows: each starts where the last clean move run ended, less an hour.';

-- The chain's lookup: the newest clean move run.
create index if not exists quote_sent_check_runs_chain
  on public.quote_sent_check_runs (window_to desc)
  where mode = 'move' and finished_at is not null and error is null;

create table if not exists public.quote_sent_moves (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.quote_sent_check_runs (id),
  hubspot_deal_id text not null,
  pipeline_id text not null,
  from_stage text not null,
  to_stage text not null,
  hubspot_quote_id text not null,
  hubspot_email_id text not null,
  email_sent_at timestamptz not null,
  outcome text not null check (outcome in ('moved', 'would_move', 'failed', 'stage_changed')),
  error text,
  created_at timestamptz not null default now()
);

comment on table public.quote_sent_moves is
  'Deals the quote-sent check moved to Quotation sent (or would have, in a report run), with the logged email and the HubSpot quote whose link it carried.';

create index if not exists quote_sent_moves_deal
  on public.quote_sent_moves (hubspot_deal_id, created_at desc);

-- A deal moves on a given email once. A rep who moves it back and sends the link again sends a new email.
create unique index if not exists quote_sent_moves_once
  on public.quote_sent_moves (hubspot_deal_id, hubspot_email_id)
  where outcome = 'moved';

alter table public.quote_sent_check_runs enable row level security;
alter table public.quote_sent_moves enable row level security;

do $$
declare t text;
begin
  foreach t in array array['quote_sent_check_runs', 'quote_sent_moves']
  loop
    execute format('drop policy if exists "Service role full access" on public.%I', t);
    execute format(
      'create policy "Service role full access" on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['quote_sent_check_runs', 'quote_sent_moves']
  loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t and rowsecurity) then
      raise exception 'row level security is off on %', t;
    end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'authenticated')
    ) then
      raise exception 'anon or authenticated still hold grants on %', t;
    end if;
  end loop;
end $$;
