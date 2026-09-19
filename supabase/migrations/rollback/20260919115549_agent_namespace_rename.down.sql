-- Rollback for 20260919115549_agent_namespace_rename.
--
-- Reverses the rename in the same shape it was applied: rename first, so every
-- OID and therefore every dependency survives, then rewrite each function body
-- from its own definition. A bare rename in either direction would leave the
-- bodies calling names that no longer exist, and it would fail at runtime rather
-- than here.
--
-- ORDER MATTERS AGAINST THE OTHER TWO ROLLBACKS. Run
-- 20260919115618_agent_product_family_search_path.down.sql and
-- 20260919115605_agent_stock_enough_revoke_anon.down.sql BEFORE this one, since
-- both name agent_ objects that this script renames away.
--
-- The `agent` discriminator columns are dropped. That is lossless today because
-- only one agent has ever written a row, but if a second agent has written any
-- by the time this runs, STOP: dropping the column silently merges two agents'
-- ledgers into one indistinguishable set. The guard below refuses in that case.

do $guard$
declare n int;
begin
  select count(*) into n from public.agent_tool_calls where agent <> 'jack';
  if n > 0 then
    raise exception 'refusing to roll back: agent_tool_calls holds % rows from an agent other than jack, and dropping the agent column would make them indistinguishable', n;
  end if;
  select count(*) into n from public.agent_emails where agent <> 'jack';
  if n > 0 then
    raise exception 'refusing to roll back: agent_emails holds % rows from an agent other than jack', n;
  end if;
end
$guard$;

-- The three-argument stock function goes, and the two-argument Australian form
-- comes back exactly as it was.
drop function if exists public.agent_stock_enough(text, numeric, text);

create or replace function public.agent_stock_enough(p_product text, p_quantity numeric)
returns table(product text, enough text, as_of date)
language plpgsql
stable
security definer
set search_path to 'public', 'eb_operations'
as $function$
declare
  v_family text := public.agent_product_family(p_product);
  v_buffer numeric;
  v_cap    numeric;
  v_age    integer;
  v_date   date;
  v_qty    numeric;
begin
  product := v_family;
  enough  := 'unknown';
  as_of   := null;

  if v_family is null or p_quantity is null or p_quantity <= 0 then
    return next; return;
  end if;

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
  where xero_org = 'AUSTRALIA';

  if v_date is null or v_date < current_date - v_age then
    return next; return;
  end if;

  select coalesce(sum(qty_on_hand), 0) into v_qty
  from eb_operations.inventory_snapshot
  where xero_org = 'AUSTRALIA'
    and snapshot_date = v_date
    and product_family = v_family;

  as_of  := v_date;
  enough := case when v_qty - v_buffer >= p_quantity then 'yes' else 'no' end;
  return next;
  return;
end
$function$;

revoke all   on function public.agent_stock_enough(text, numeric) from public;
revoke execute on function public.agent_stock_enough(text, numeric) from anon;
revoke execute on function public.agent_stock_enough(text, numeric) from authenticated;
grant  execute on function public.agent_stock_enough(text, numeric) to service_role;

-- The discriminator.
drop index if exists public.agent_tool_calls_agent_idx;
drop index if exists public.agent_emails_agent_idx;
alter table public.agent_tool_calls drop column if exists agent;
alter table public.agent_emails     drop column if exists agent;

-- The note the forward migration generalised.
update public.agent_stock_policy
   set note = 'Default. yes only when AU on-hand minus the buffer covers the request; above '
              || 'max_qty, or when the snapshot is older than max_age_days, answer unknown so '
              || 'the written quote confirms it.'
 where family = '*';

-- ORDER: RELATIONS BEFORE FUNCTION BODIES.
-- agent_email_reserve declares `v_existing public.agent_emails%rowtype`, so a
-- body rewritten to say jack_emails will not COMPILE until that table exists
-- under its old name. Proved by dry-running this file: with the blocks the other
-- way round it failed with 'relation "public.jack_emails" does not exist', which
-- is the worst possible moment to discover it.

-- Relations, indexes and the sequence.
alter index public.agent_emails_conversation_idx     rename to jack_emails_conversation_idx;
alter index public.agent_emails_created_at_idx       rename to jack_emails_created_at_idx;
alter index public.agent_emails_gmail_message_id_key rename to jack_emails_gmail_message_id_key;
alter index public.agent_emails_idempotency_key_key  rename to jack_emails_idempotency_key_key;
alter index public.agent_emails_intended_to_idx      rename to jack_emails_intended_to_idx;
alter index public.agent_emails_pkey                 rename to jack_emails_pkey;
alter index public.agent_emails_thread_idx           rename to jack_emails_thread_idx;
alter index public.agent_stock_policy_pkey           rename to jack_stock_policy_pkey;
alter index public.agent_tool_calls_conversation_idx rename to jack_tool_calls_conversation_idx;
alter index public.agent_tool_calls_once             rename to jack_tool_calls_once;
alter index public.agent_tool_calls_pkey             rename to jack_tool_calls_pkey;

alter sequence public.agent_tool_calls_id_seq rename to jack_tool_calls_id_seq;

alter view  public.agent_list_prices   rename to jack_list_prices;
alter table public.agent_tool_calls    rename to jack_tool_calls;
alter table public.agent_stock_policy  rename to jack_stock_policy;
alter table public.agent_emails        rename to jack_emails;

-- Functions back to jack_, OIDs preserved.
alter function public.agent_product_family(text)        rename to jack_product_family;
alter function public.agent_list_price(text, text)      rename to jack_list_price;
alter function public.agent_urgent_price(text, text)    rename to jack_urgent_price;
alter function public.agent_stock_enough(text, numeric) rename to jack_stock_enough;
alter function public.agent_email_reserve(text, text, text, text, text, text, text, text, boolean, jsonb)
  rename to jack_email_reserve;
alter function public.agent_email_finalise(uuid, text, text, text, text, text, text)
  rename to jack_email_finalise;

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
      and p.proname in ('jack_product_family','jack_list_price','jack_urgent_price',
                        'jack_stock_enough','jack_email_reserve','jack_email_finalise')
  loop
    def := pg_get_functiondef(r.oid);
    if def like '%agent\_%' then
      execute replace(def, 'agent_', 'jack_');
      raise notice 'rewrote body of %', r.proname;
    end if;
  end loop;
end
$rewrite$;

-- src/lib/agent-quote/data.ts reads agent_tool_calls. Roll the Hub back with
-- this, or isConversationBound fails closed and every agent quote returns
-- NOT_BOUND.
