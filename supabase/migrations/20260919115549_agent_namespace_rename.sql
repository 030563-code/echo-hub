-- APPLIED 2026-09-19 via MCP apply_migration on korylyniwsqtsvzuzydg as version
-- 20260919115549. This file is the repo record of what ran. Never db push.
--
-- Dry-run first: the whole thing was executed inside an explicit transaction that
-- ended in a raised exception, so it rolled back, and the exception carried the
-- verification out. It reported 0 jack_ functions left, 6 agent_ functions (5
-- SECURITY DEFINER, 0 with a wrong ACL), every rewritten function still
-- returning rows, and agent_tool_calls holding its 194 existing rows all marked
-- agent='jack'. Only then was it applied for real.
--
-- Two follow-ups were needed and are recorded as their own migrations:
--   20260919115605 agent_stock_enough_revoke_anon
--   20260919115618 agent_product_family_search_path
-- Rename the shared AI-agent layer out of one agent's name, and give the one
-- function that needed it a region parameter.
--
-- Dean, 19 Sep 2026: "the functions like jack_urgent_price etc. need to be
-- renamed to something that would be a scaleable name like ai_agent_urgent_price
-- because we can pass in the countries, this allows us to have multiple ai
-- agents potentially."
--
-- Prefix is `agent_` rather than `ai_agent_` because the Hub already
-- standardises on that word everywhere: /api/agent/quote, src/lib/agent-quote/,
-- agent-account.ts, agent-scope.ts, agentUserId(), AGENT_QUOTE_SECRET. A
-- database saying ai_agent_ while every application symbol says agent_ is
-- permanent friction for no gain.
--
-- Done now because ANZ is paused pending an Australian company registration, so
-- Jack is dormant and nothing live depends on these names. It will never be
-- cheaper.
--
-- WHAT IS DELIBERATELY NOT HERE. No agent_registry table. `profiles` already
-- holds pipeline_id, allowed_depots and allowed_quote_templates; user_organisations
-- links a profile to an entity; and public.entities already carries
-- default_currency, xero_tenant_id, legal_name and the registered address for all
-- seven organisations. Jack's AUD is already derivable as
-- profiles -> user_organisations -> entities.default_currency ('EB-AUSTRALIA' -> AUD),
-- and Vendite's EUR will come from 'EB-GROUP' the same way. A registry table
-- would have duplicated three tables that already exist.
--
-- THE TRAP THIS MIGRATION IS SHAPED AROUND. All six functions store their bodies
-- as text, so ALTER FUNCTION ... RENAME alone would leave every one of them
-- calling names that no longer exist, and it would fail at runtime rather than at
-- migration time. So each function is renamed (which preserves its OID, and with
-- it the view and every other dependency) and then rewritten in place from its
-- own pg_get_functiondef output. Regenerating rather than retyping is deliberate:
-- a retyped migration tail has silently dropped a SECURITY DEFINER in this
-- project before.


-- ---------------------------------------------------------------- 1. relations
-- ALTER ... RENAME preserves ACLs, RLS, data, defaults and dependencies.
alter table public.jack_emails        rename to agent_emails;
alter table public.jack_stock_policy  rename to agent_stock_policy;
alter table public.jack_tool_calls    rename to agent_tool_calls;
alter view  public.jack_list_prices   rename to agent_list_prices;

-- Postgres does NOT rename indexes or sequences when their table is renamed.
alter sequence public.jack_tool_calls_id_seq rename to agent_tool_calls_id_seq;

alter index public.jack_emails_conversation_idx     rename to agent_emails_conversation_idx;
alter index public.jack_emails_created_at_idx       rename to agent_emails_created_at_idx;
alter index public.jack_emails_gmail_message_id_key rename to agent_emails_gmail_message_id_key;
alter index public.jack_emails_idempotency_key_key  rename to agent_emails_idempotency_key_key;
alter index public.jack_emails_intended_to_idx      rename to agent_emails_intended_to_idx;
alter index public.jack_emails_pkey                 rename to agent_emails_pkey;
alter index public.jack_emails_thread_idx           rename to agent_emails_thread_idx;
alter index public.jack_stock_policy_pkey           rename to agent_stock_policy_pkey;
alter index public.jack_tool_calls_conversation_idx rename to agent_tool_calls_conversation_idx;
alter index public.jack_tool_calls_once             rename to agent_tool_calls_once;
alter index public.jack_tool_calls_pkey             rename to agent_tool_calls_pkey;

-- ---------------------------------------------------------------- 2. functions
-- Rename first: the OID survives, so public.agent_list_prices (which calls
-- product_family) keeps working throughout.
alter function public.jack_product_family(text)                 rename to agent_product_family;
alter function public.jack_list_price(text, text)               rename to agent_list_price;
alter function public.jack_urgent_price(text, text)             rename to agent_urgent_price;
alter function public.jack_stock_enough(text, numeric)          rename to agent_stock_enough;
alter function public.jack_email_reserve(text, text, text, text, text, text, text, text, boolean, jsonb)
  rename to agent_email_reserve;
alter function public.jack_email_finalise(uuid, text, text, text, text, text, text)
  rename to agent_email_finalise;

-- Now rewrite each body from its own definition. CREATE OR REPLACE keeps the
-- OID, the grants, SECURITY DEFINER, the volatility and the SET search_path,
-- all of which pg_get_functiondef already carries.
do $rewrite$
declare
  r record;
  def text;
begin
  for r in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('agent_product_family','agent_list_price','agent_urgent_price',
                        'agent_stock_enough','agent_email_reserve','agent_email_finalise')
  loop
    def := pg_get_functiondef(r.oid);
    if def like '%jack\_%' then
      execute replace(def, 'jack_', 'agent_');
      raise notice 'rewrote body of %', r.proname;
    end if;
  end loop;
end
$rewrite$;

-- ------------------------------------------------- 3. the agent discriminator
-- One shared ledger per concern, discriminated by agent, rather than a parallel
-- set of tables per agent. These are append-only idempotency and audit tables,
-- so the isolation a second copy would buy is worth less than the divergence it
-- would cost. Existing rows are Jack's by definition: he is the only agent that
-- has ever written one.
alter table public.agent_tool_calls add column if not exists agent text not null default 'jack';
alter table public.agent_emails     add column if not exists agent text not null default 'jack';

create index if not exists agent_tool_calls_agent_idx on public.agent_tool_calls (agent, created_at desc);
create index if not exists agent_emails_agent_idx     on public.agent_emails     (agent, created_at desc);

-- --------------------------------------------------- 4. stock takes the region
-- The one function that genuinely needed a region parameter: it hardcoded
-- xero_org = 'AUSTRALIA' in two places. The default keeps every existing Jack
-- caller behaving exactly as before, so this is additive.
create or replace function public.agent_stock_enough(
  p_product text,
  p_quantity numeric,
  p_xero_org text default 'AUSTRALIA'
)
returns table(product text, enough text, as_of date)
language plpgsql
stable
security definer
set search_path to 'public', 'eb_operations'
as $function$
declare
  v_family text := public.agent_product_family(p_product);
  v_org    text := upper(btrim(coalesce(p_xero_org, '')));
  v_buffer numeric;
  v_cap    numeric;
  v_age    integer;
  v_date   date;
  v_qty    numeric;
begin
  product := v_family;
  enough  := 'unknown';
  as_of   := null;

  if v_family is null or p_quantity is null or p_quantity <= 0 or v_org = '' then
    return next; return;
  end if;

  -- Accessories are pooled in the snapshot, so hooks and bungies are never
  -- answered from it.
  if v_family in ('Hooks', 'Bungies', 'Fitting Kit', 'Vertical Fitting Kit') then
    return next; return;
  end if;

  select coalesce(p.reserve_buffer, d.reserve_buffer),
         coalesce(p.max_qty, d.max_qty),
         coalesce(p.max_age_days, d.max_age_days)
    into v_buffer, v_cap, v_age
  from public.agent_stock_policy d
  left join public.agent_stock_policy p on p.family = v_family
  where d.family = '*';

  if v_buffer is null or p_quantity > v_cap then
    return next; return;
  end if;

  select max(snapshot_date) into v_date
  from eb_operations.inventory_snapshot
  where xero_org = v_org;

  -- No rows for this organisation, or a stale snapshot, both answer unknown so
  -- the written quote confirms availability instead of the agent guessing.
  if v_date is null or v_date < current_date - v_age then
    return next; return;
  end if;

  select coalesce(sum(qty_on_hand), 0) into v_qty
  from eb_operations.inventory_snapshot
  where xero_org = v_org
    and snapshot_date = v_date
    and product_family = v_family;

  as_of  := v_date;
  enough := case when v_qty - v_buffer >= p_quantity then 'yes' else 'no' end;
  return next;
  return;
end
$function$;

-- The two-argument form is gone: replaced by the three-argument one above, whose
-- default preserves its behaviour. Dropped so no caller can bind to a stale
-- signature that silently means Australia.
drop function if exists public.agent_stock_enough(text, numeric);

-- The policy row's note described Australia. The table is family-keyed and the
-- region now arrives as an argument, so the wording follows.
update public.agent_stock_policy
   set note = 'Default. yes only when the requested organisation''s on-hand minus the buffer '
              || 'covers the request; above max_qty, or when that snapshot is older than '
              || 'max_age_days, answer unknown so the written quote confirms it.'
 where family = '*';

-- ------------------------------------------------------------------ 5. grants
-- pg_get_functiondef does not carry grants, and the new three-argument
-- agent_stock_enough is a genuinely new object. Every one of these is
-- service_role only: nothing here is callable by anon or authenticated.
revoke all on function public.agent_stock_enough(text, numeric, text) from public;
grant execute on function public.agent_stock_enough(text, numeric, text) to service_role;

