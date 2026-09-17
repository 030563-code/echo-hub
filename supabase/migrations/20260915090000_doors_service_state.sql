-- CORTEX doors: service state for the scoped MCP gateway (cortex-doors on Railway).
--
-- APPLIED LIVE via MCP apply_migration (doors_service_state) on korylyniwsqtsvzuzydg.
-- This file is the repo mirror. Never `db push`.
--
-- WHAT THIS IS NOT. It holds no HubSpot and no Xero records. HubSpot and Xero stay
-- the systems of record and the door reads them live on every call. What lives here
-- is the service's own state: which agent may ask, on whose behalf, and what it did.
-- CI's `supabase db diff --linked --schema public` does not see this schema, on purpose.
--
-- THE SHAPE. One login role, `doors_api`, reaches everything through SECURITY DEFINER
-- functions. It cannot read doors.agents or doors.viewers directly, so a SQL injection
-- through the service cannot enumerate agent key hashes or the viewer register. It can
-- append to doors.access_log and never read it back.
--
-- Supabase's default privileges are per schema (pg_default_acl carries rows for public,
-- eb_operations, storage and the graphql schemas, and none that are global), so a new
-- schema starts with nothing granted to anon, authenticated or service_role. The
-- revokes below are belt and braces, and they are what proof P1 asserts.

create schema if not exists doors;
comment on schema doors is
  'Service state for the cortex-doors MCP gateway: agent keys, viewer register, audit log. No CRM or finance records are stored here; the door reads HubSpot and Xero live.';

revoke all on schema doors from public;
revoke all on schema doors from anon, authenticated, service_role;

-- ---------------------------------------------------------------- the role
-- No password: Dean sets it once in the Supabase SQL editor and seals the
-- connection string on Railway, so it never passes through a migration, a repo
-- or a transcript. Until then the role exists and cannot log in.
--
-- NOINHERIT and no memberships, so there is no role to escalate to. NOBYPASSRLS
-- so a future policy cannot be read around. The statement timeout bounds a
-- runaway query; the door's own queries are all sub-second.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'doors_api') then
    create role doors_api login nobypassrls noinherit nocreaterole nocreatedb;
  end if;
end
$$;

alter role doors_api set search_path = doors, pg_temp;
alter role doors_api set statement_timeout = '10s';
alter role doors_api set idle_in_transaction_session_timeout = '15s';

grant usage on schema doors to doors_api;

-- Lets the SQL editor run `set role doors_api` for the proofs without inheriting
-- its rights by default.
grant doors_api to postgres with set true, inherit false;

-- ------------------------------------------------------------------ agents
-- One row per (brain, domain). The bearer an agent presents is `<agent_key>.<secret>`;
-- only the sha256 of the secret is stored, so a copy of this table does not let
-- anyone call the door.
--
-- `ceiling` is the hard wall: the widest set of HubSpot teams this key may ever
-- reach, whatever viewer it names. '{*}' means portal-wide.
-- `allowed_viewers` is the second wall: the addresses this key may act for.
-- `allowed_tools` narrows the surface; '{*}' means every tool in its domain.
create table if not exists doors.agents (
  agent_key        text primary key
                     check (agent_key ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  domain           text        not null check (domain in ('crm', 'fin')),
  key_sha256       bytea,
  key_prev_sha256  bytea,
  prev_expires_at  timestamptz,
  ceiling          text[]      not null default '{}',
  allowed_tools    text[]      not null default '{*}',
  allowed_viewers  text[]      not null default '{}',
  enabled          boolean     not null default false,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint agents_prev_needs_expiry
    check (key_prev_sha256 is null or prev_expires_at is not null)
);

comment on table doors.agents is
  'One row per agent key. enabled=false until Dean stores a hash with bin/keygen. A previous hash is only accepted until prev_expires_at, so a rotation cannot leave a permanent second key.';

-- ----------------------------------------------------------------- viewers
-- The people a door may build an answer for. A row here wins over derivation;
-- anyone without a row is derived live from their HubSpot owner record by the
-- service (active seat, primary team, admin teams stripped), which is why there
-- is no owners table in this schema.
--
-- A row whose agent_key is set is a service viewer: a routine's own identity,
-- usable only by that agent and by nobody else.
create table if not exists doors.viewers (
  email           text primary key check (email = lower(email)),
  owner_id        text,
  scope           text        not null check (scope in ('global', 'team')),
  teams           text[]      not null default '{}',
  may_see_desk    boolean     not null default false,
  may_name_peers  boolean     not null default false,
  agent_key       text        references doors.agents (agent_key) on delete cascade,
  note            text,
  created_at      timestamptz not null default now(),
  constraint viewers_team_scope_needs_teams
    check (scope <> 'team' or cardinality(teams) > 0)
);

comment on table doors.viewers is
  'Explicit viewer profiles, seeded from VIEWERS in cso-brain/scripts/sales-desk-pack.mjs. A team scope with no teams is rejected by the check constraint: it would read as "no filter" rather than "no access".';

-- --------------------------------------------------------------- audit log
-- One row per tool call, including every refusal. Filter KEYS are recorded and
-- filter values are not, so the log says "Claire searched deals by pipeline and
-- close date" and never what she was looking for. Results are never logged.
create table if not exists doors.access_log (
  id               bigint generated always as identity primary key,
  ts               timestamptz not null default now(),
  agent_key        text,
  viewer_email     text,
  effective_scope  text[],
  tool             text,
  filter_keys      text[],
  rows_returned    integer,
  upstream_calls   integer,
  upstream_scoped  boolean,
  ms               integer,
  refused_reason   text
);

create index if not exists access_log_ts on doors.access_log (ts desc);
create index if not exists access_log_agent_viewer on doors.access_log (agent_key, viewer_email, ts desc);

comment on table doors.access_log is
  'Append-only audit. doors_api may insert and may not read: an agent cannot mine the log for other people activity. Purged at 90 days by doors.purge_access_log().';

alter table doors.agents     enable row level security;
alter table doors.viewers    enable row level security;
alter table doors.access_log enable row level security;
alter table doors.agents     force row level security;
alter table doors.viewers    force row level security;
alter table doors.access_log force row level security;

-- The only grant on any table. Everything else goes through the functions below.
grant insert on doors.access_log to doors_api;
create policy "doors_api appends audit rows"
  on doors.access_log for insert to doors_api with check (true);

-- ------------------------------------------------------------- functions
-- Why the comparison is in SQL rather than a constant-time compare in Node: the
-- value compared is a sha256 digest, not the secret. A timing oracle on a digest
-- comparison would leak the digest, which is useless without its preimage. The
-- lookup is by primary key, so there is one candidate row and no enumeration.
create or replace function doors.authenticate(p_agent_key text, p_key_sha bytea)
returns jsonb
language sql
stable
security definer
set search_path = doors, pg_temp
as $$
  select to_jsonb(x)
  from (
    select a.agent_key, a.domain, a.ceiling, a.allowed_tools, a.allowed_viewers
    from doors.agents a
    where a.agent_key = p_agent_key
      and a.enabled
      and p_key_sha is not null
      and (
        a.key_sha256 = p_key_sha
        or (a.key_prev_sha256 = p_key_sha
            and a.prev_expires_at is not null
            and a.prev_expires_at > now())
      )
  ) x;
$$;

comment on function doors.authenticate(text, bytea) is
  'The one way in. Returns the agent identity as jsonb, or null for a wrong secret, a disabled row, an unknown key or an expired previous hash. A null key_sha256 matches nothing, so a seeded row with no hash cannot be used.';

create or replace function doors.resolve_viewer(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = doors, pg_temp
as $$
  select to_jsonb(x)
  from (
    select v.email, v.owner_id, v.scope, v.teams, v.may_see_desk, v.may_name_peers, v.agent_key
    from doors.viewers v
    where v.email = lower(trim(p_email))
  ) x;
$$;

comment on function doors.resolve_viewer(text) is
  'An explicit viewer profile, or null. Null is not a refusal: the service then derives the profile from the HubSpot owner record live, and refuses only if that yields no sales team.';

-- The hub's own view of one deal. Called only after HubSpot has confirmed the
-- deal is inside the caller's scope, because there is no mirrored team stamp
-- here to check against. Reads three tables and writes none: every touched row
-- of public.deals_registry fires an n8n webhook, so a write here would replay
-- the accepted-quote pipeline.
create or replace function doors.hub_deal_status(p_deal_id text)
returns jsonb
language sql
stable
security definer
set search_path = doors, public, pg_temp
as $$
  select jsonb_build_object(
    'hubspot_deal_id', p_deal_id,
    'registry', (
      select to_jsonb(r) from (
        select d.deal_name, d.deal_status, d.pipeline_name, d.amount, d.currency,
               d.quote_reference, d.depot_code, d.is_collection, d.updated_at
        from public.deals_registry d
        where d.hubspot_deal_id = p_deal_id
        limit 1
      ) r
    ),
    'quotes', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.created_at desc) from (
        select dq.quote_number, dq.status, dq.amount, dq.currency,
               dq.quote_link, dq.expires_on, dq.created_at
        from public.deal_quotes dq
        where dq.hubspot_deal_id = p_deal_id
      ) q
    ), '[]'::jsonb),
    'invoices', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.created_at desc) from (
        select ci.invoice_number, ci.status, ci.total, ci.currency,
               ci.invoice_date, ci.due_date, ci.xero_invoice_number, ci.created_at
        from public.customer_invoices ci
        where ci.hubspot_deal_id = p_deal_id
      ) i
    ), '[]'::jsonb)
  );
$$;

comment on function doors.hub_deal_status(text) is
  'Read-only Hub status for one deal: registry row, quotes, customer invoices. The caller must already have confirmed the deal is in the viewer scope against HubSpot.';

create or replace function doors.purge_access_log(p_keep_days integer default 90)
returns integer
language sql
volatile
security definer
set search_path = doors, pg_temp
as $$
  with gone as (
    delete from doors.access_log where ts < now() - make_interval(days => greatest(p_keep_days, 1))
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function doors.authenticate(text, bytea)      from public;
revoke all on function doors.resolve_viewer(text)           from public;
revoke all on function doors.hub_deal_status(text)          from public;
revoke all on function doors.purge_access_log(integer)      from public;

grant execute on function doors.authenticate(text, bytea)   to doors_api;
grant execute on function doors.resolve_viewer(text)        to doors_api;
grant execute on function doors.hub_deal_status(text)       to doors_api;
grant execute on function doors.purge_access_log(integer)   to doors_api;

-- --------------------------------------------------------------- the seed
-- Every agent starts disabled with no hash. Dean runs bin/keygen once per agent,
-- which prints the key once and the SQL that stores its hash and enables the row.
--
-- ceiling '{*}' with an explicit allowed_viewers list is the approved shape: the
-- viewer decides the scope and the list decides which viewers this key may name.
-- A first-seen (agent, viewer) pair is an alert, not a block.
insert into doors.agents (agent_key, domain, ceiling, allowed_tools, allowed_viewers, enabled, note)
values
  ('cso', 'crm', '{*}', '{*}',
   '{geoff.callum@echobarrier.com,jillian.rocco@echobarrier.com,claire.lavoisier@echobarrier.com,gregg.murfin@echobarrier.com,fraser.hadlow@echobarrier.com,juraj@echobarrier.eu,andy.murphy@echobarrier.com,dean@corserv.co.uk,cso.service@no-mail.echobarrier.com}',
   false, 'Sales desk. Answers the region leads and the director by email, and runs the desk pack on a routine as cso.service.'),
  ('cmo', 'crm',
   '{*}',
   '{catalog_properties,pipelines,search_deals,deal_summary,get_deal,search_companies,get_company,search_contacts,freshness}',
   '{andy.murphy@echobarrier.com,dean@corserv.co.uk,cmo.service@no-mail.echobarrier.com}',
   false, 'Marketing ROI reads deals by source and their contacts. Confirm with Dean who else emails the CMO before widening allowed_viewers.'),
  ('ceo', 'crm',
   '{*}',
   '{deal_summary,pipelines,freshness}',
   '{andy.murphy@echobarrier.com,geoff.callum@echobarrier.com,dean@corserv.co.uk,ceo.service@no-mail.echobarrier.com}',
   false, 'Totals only. The CEO asks how the desk is doing, never for a row list.'),
  ('hubspot-specialist', 'crm', '{*}', '{*}',
   '{andy.murphy@echobarrier.com,dean@corserv.co.uk,hubspot-specialist.service@no-mail.echobarrier.com}',
   false, 'The platform specialist. Its first MCP surface: today it has none and curls HubSpot directly.'),
  ('cto', 'crm',
   '{*}',
   '{catalog_properties,pipelines,owners_and_teams,freshness}',
   '{cto.service@no-mail.echobarrier.com,dean@corserv.co.uk}',
   false, 'Property watch only. It reads the catalogue and the pipelines and never a deal.')
on conflict (agent_key) do nothing;

-- The six people in VIEWERS, with their live HubSpot addresses (read from
-- /crm/v3/owners on 2026-09-15). Anyone not listed is derived from their own
-- HubSpot record, which is the route that scales: a new rep needs no row here.
insert into doors.viewers (email, owner_id, scope, teams, may_see_desk, may_name_peers, note)
values
  ('jillian.rocco@echobarrier.com',    '82370091', 'team',   '{949190}',        false, false, 'R1 North America. Her secondary Admin 2025 membership is deliberately not a scope.'),
  ('claire.lavoisier@echobarrier.com', '40348393', 'team',   '{570270,592522}', false, false, 'R2 and R4. Her book spans four pipelines, so the team is the dimension that holds.'),
  ('gregg.murfin@echobarrier.com',     '30357679', 'team',   '{592629,57567}',  false, false, 'R7 and R8.'),
  ('geoff.callum@echobarrier.com',     '30234944', 'global', '{}',              true,  true,  'Sales director. Runs the desk, so every region and every name.'),
  ('andy.murphy@echobarrier.com',      '30229254', 'global', '{}',              true,  true,  'Principal.'),
  ('dean@corserv.co.uk',               '85301222', 'global', '{}',              true,  true,  'Operator. HubSpot super admin with no team membership.')
on conflict (email) do nothing;

-- One service viewer per agent, for routines that answer nobody in particular.
-- Each is usable only by its own agent, so a leaked key cannot borrow another
-- agent's identity to widen itself.
insert into doors.viewers (email, owner_id, scope, teams, may_see_desk, may_name_peers, agent_key, note)
select a.agent_key || '.service@no-mail.echobarrier.com', null, 'global', '{}', true, true, a.agent_key,
       'Service identity for the ' || a.agent_key || ' routines. Not a person, and deliberately not borrowing one.'
from doors.agents a
on conflict (email) do nothing;
