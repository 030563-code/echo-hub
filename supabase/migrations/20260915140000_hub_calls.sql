-- The call log behind /calls, and the reconciliation of phone-only contacts.
--
-- Dean, 15 Sep 2026: "a /calls tab for the sales people all the organisations
-- ... the calls create a contact under a phone number automatically and the
-- reps create a contact in hubspot but dont put in thier phone number ... the
-- hub should make it easy for them to sync a contact to a phone number via the
-- calls."
--
-- Where the rows come from: every country handler on the phone system already
-- POSTs a full call payload (transcript, English translation, summary,
-- recording, caller, office, department, the HubSpot contact it matched or
-- created) to a webhook node that is connected to nothing, so all of it is
-- discarded. Wiring that node to /api/calls/ingest is what fills this table.
--
-- Why the Hub keeps its own copy rather than reading HubSpot live:
--  - the transcript is in the payload and is NOT on the HubSpot call object;
--  - a missed call needs a reason from a rep, which is Hub state, not CRM state;
--  - who linked what, and when, has to be answerable afterwards;
--  - the list is one query instead of a call search plus an association read
--    plus a contact batch read per page.
--
-- Applied live via MCP apply_migration on korylyniwsqtsvzuzydg. This file is
-- the repo record. Never db push.

create table public.hub_calls (
  id uuid primary key default gen_random_uuid(),

  -- Identity. call_sid is Twilio's own id and the idempotency key: the same
  -- call arrives more than once (an n8n retry, a manual replay, an answered
  -- handler followed by a department notification), and it must stay one row.
  call_sid text not null unique,
  recording_sid text,
  ingest_count integer not null default 1,
  source text not null default 'n8n:sales-transcript',
  received_at timestamptz not null default now(),

  -- Telephony. caller_phone is kept exactly as it arrived, which is frequently
  -- the literal string 'anonymous'. caller_phone_e164 is null unless the value
  -- really is a number, so nothing downstream can mistake a withheld caller for
  -- one, the way the phone system's own digit-stripping does.
  caller_phone text,
  caller_phone_e164 text,
  called_phone text,
  diverted_to text,
  duration_seconds integer,
  call_at timestamptz not null,
  -- A Twilio API url. It needs Twilio credentials, so it is a reference, not a
  -- link a browser can play.
  recording_url text,

  -- Classification. No CHECK on office or department: a country or a department
  -- added upstream must not make the Hub reject the call. call_type is checked
  -- only because the endpoint maps anything unrecognised to 'other' first.
  office text not null default 'Unknown',
  department text not null default 'unknown',
  call_type text not null default 'other'
    check (call_type in ('answered', 'voicemail', 'department_notification', 'other')),
  call_status text,
  language text,
  rep_email text,

  -- What was said. The two html fields are model output that arrived over an
  -- unsigned webhook: stored, and rendered as text, never as markup.
  transcript text,
  transcript_english text,
  summary text,
  formatted_transcript_html text,
  key_quotes_html text,

  -- HubSpot as the automation left it, plus a snapshot of the contact taken at
  -- ingest so the list needs no round trip and the audit trail records who the
  -- contact WAS, not who they are now.
  hubspot_contact_id text,
  hubspot_match_source text,
  hubspot_call_id text,
  contact_firstname text,
  contact_lastname text,
  contact_email text,
  contact_phone text,
  contact_snapshot_at timestamptz,

  -- What a person did about it. This CHECK is deliberate: link_state drives an
  -- index, the default filter and the action gate, so a typo must fail loudly.
  link_state text not null default 'unreviewed'
    check (link_state in ('unreviewed', 'needs_link', 'linked', 'ignored', 'no_contact')),
  linked_contact_id text,
  merged_contact_id text,
  linked_by_uid uuid references auth.users(id) on delete set null,
  linked_at timestamptz,
  link_note text,

  -- Dean, 15 Sep 2026: a missed call needs a reason before it may be linked.
  -- The code is one of a short list so missed calls can be counted by office and
  -- month; the note is the rep's own words beside it, never instead of it.
  missed_reason text,
  missed_note text,
  missed_reason_by_uid uuid references auth.users(id) on delete set null,
  missed_reason_at timestamptz,

  -- The body exactly as received. The typed columns above are a closed list, so
  -- this is how a field somebody adds upstream survives until the Hub models it.
  raw_payload jsonb not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hub_calls_recent_idx on public.hub_calls (call_at desc);
create index hub_calls_office_idx on public.hub_calls (office, call_at desc);
-- The queue the tab opens on.
create index hub_calls_queue_idx on public.hub_calls (call_at desc) where link_state = 'needs_link';
-- Linking one call relinks every other call sitting on the same placeholder.
create index hub_calls_contact_idx on public.hub_calls (hubspot_contact_id) where hubspot_contact_id is not null;

comment on table public.hub_calls is
  'Sales calls from the phone system, with their transcripts, and the reconciliation of the placeholder contacts the automation creates from a phone number. Written only by /api/calls/ingest and the /calls actions, both service role.';
comment on column public.hub_calls.caller_phone_e164 is
  'The caller as a number, or null. Null for a withheld caller, which arrives as the literal string anonymous.';
comment on column public.hub_calls.hubspot_match_source is
  'matched or created, as the phone system reported it. Not trusted on its own: a withheld caller is reported as matched against a junk contact.';

-- Served by the app on the service role only, never through PostgREST. The
-- grants go rather than being narrowed, because RLS does not restrain TRUNCATE
-- and this project grants authenticated TRUNCATE on every new public table.
alter table public.hub_calls enable row level security;
revoke all on public.hub_calls from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ingest. An upsert that ENRICHES rather than replaces.
--
-- The same call_sid can arrive twice with different richness: the answered
-- handler carries a transcript, a later department notification for the same
-- call carries none. A plain upsert would blank the transcript. Each field
-- therefore keeps what it has unless the new payload actually has something,
-- and the columns a rep owns (link_state once decided, the missed reason, who
-- linked it) are never touched by an inbound payload at all.
-- ---------------------------------------------------------------------------
create or replace function public.hub_ingest_phone_call(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_created boolean;
  v_state text;
begin
  if coalesce(p->>'call_sid', '') = '' then
    raise exception 'A call needs a call_sid.' using errcode = '22023';
  end if;

  insert into public.hub_calls (
    call_sid, recording_sid, caller_phone, caller_phone_e164, called_phone, diverted_to,
    duration_seconds, call_at, recording_url, office, department, call_type, call_status,
    language, rep_email, transcript, transcript_english, summary, formatted_transcript_html,
    key_quotes_html, hubspot_contact_id, hubspot_match_source, contact_firstname,
    contact_lastname, contact_email, contact_phone, contact_snapshot_at, link_state, raw_payload
  )
  values (
    p->>'call_sid', p->>'recording_sid', p->>'caller_phone', p->>'caller_phone_e164',
    p->>'called_phone', p->>'diverted_to', (p->>'duration_seconds')::integer,
    (p->>'call_at')::timestamptz, p->>'recording_url',
    coalesce(nullif(p->>'office', ''), 'Unknown'), coalesce(nullif(p->>'department', ''), 'unknown'),
    coalesce(nullif(p->>'call_type', ''), 'other'), p->>'call_status', p->>'language',
    p->>'rep_email', p->>'transcript', p->>'transcript_english', p->>'summary',
    p->>'formatted_transcript_html', p->>'key_quotes_html', p->>'hubspot_contact_id',
    p->>'hubspot_match_source', p->>'contact_firstname', p->>'contact_lastname',
    p->>'contact_email', p->>'contact_phone', (p->>'contact_snapshot_at')::timestamptz,
    coalesce(nullif(p->>'link_state', ''), 'unreviewed'), coalesce(p->'raw_payload', p)
  )
  on conflict (call_sid) do update set
    recording_sid             = coalesce(excluded.recording_sid, hub_calls.recording_sid),
    caller_phone              = coalesce(excluded.caller_phone, hub_calls.caller_phone),
    caller_phone_e164         = coalesce(excluded.caller_phone_e164, hub_calls.caller_phone_e164),
    called_phone              = coalesce(excluded.called_phone, hub_calls.called_phone),
    diverted_to               = coalesce(excluded.diverted_to, hub_calls.diverted_to),
    duration_seconds          = coalesce(excluded.duration_seconds, hub_calls.duration_seconds),
    recording_url             = coalesce(excluded.recording_url, hub_calls.recording_url),
    call_status               = coalesce(excluded.call_status, hub_calls.call_status),
    language                  = coalesce(excluded.language, hub_calls.language),
    rep_email                 = coalesce(excluded.rep_email, hub_calls.rep_email),
    transcript                = coalesce(excluded.transcript, hub_calls.transcript),
    transcript_english        = coalesce(excluded.transcript_english, hub_calls.transcript_english),
    summary                   = coalesce(excluded.summary, hub_calls.summary),
    formatted_transcript_html = coalesce(excluded.formatted_transcript_html, hub_calls.formatted_transcript_html),
    key_quotes_html           = coalesce(excluded.key_quotes_html, hub_calls.key_quotes_html),
    hubspot_contact_id        = coalesce(hub_calls.hubspot_contact_id, excluded.hubspot_contact_id),
    hubspot_match_source      = coalesce(hub_calls.hubspot_match_source, excluded.hubspot_match_source),
    contact_firstname         = coalesce(excluded.contact_firstname, hub_calls.contact_firstname),
    contact_lastname          = coalesce(excluded.contact_lastname, hub_calls.contact_lastname),
    contact_email             = coalesce(excluded.contact_email, hub_calls.contact_email),
    contact_phone             = coalesce(excluded.contact_phone, hub_calls.contact_phone),
    contact_snapshot_at       = coalesce(excluded.contact_snapshot_at, hub_calls.contact_snapshot_at),
    -- A real call is never downgraded to a notification by a later payload.
    call_type = case
      when hub_calls.call_type in ('answered', 'voicemail') then hub_calls.call_type
      else excluded.call_type
    end,
    -- A replayed webhook must never undo what a rep has already decided.
    link_state = case
      when hub_calls.link_state in ('linked', 'ignored') then hub_calls.link_state
      else excluded.link_state
    end,
    raw_payload  = excluded.raw_payload,
    ingest_count = hub_calls.ingest_count + 1,
    updated_at   = now()
  returning id, (xmax = 0), link_state into v_id, v_created, v_state;

  return jsonb_build_object('id', v_id, 'created', v_created, 'link_state', v_state);
end;
$$;

comment on function public.hub_ingest_phone_call(jsonb) is
  'Stores one call from the phone system, keyed on call_sid. A second delivery enriches the row and never blanks a transcript or undoes a rep''s link.';

revoke all on function public.hub_ingest_phone_call(jsonb) from public, anon, authenticated;
grant execute on function public.hub_ingest_phone_call(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- The capability. One key covers seeing the calls and linking them: the rep who
-- took the call is the person who knows which contact is right (Dean, 15 Sep).
-- Seeded, not granted. Granting is a separate, deliberate act.
-- ---------------------------------------------------------------------------
insert into public.capabilities (key, module, description)
values ('calls.view', 'calls',
        'See your region''s call log with transcripts, and link a call to the right HubSpot contact')
on conflict (key) do update set module = excluded.module, description = excluded.description;
