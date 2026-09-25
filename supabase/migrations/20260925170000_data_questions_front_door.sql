-- Data questions the CORTEX front door answers without waking an agent.
--
-- WHY. A plain data question put to an agent, such as "how many barriers do we have in stock
-- globally?", cost 1 to 22 agent runs and 1 to 73 minutes in September 2026. The front door is an
-- n8n workflow that the Buzz bridge calls before it opens a Paperclip issue. It asks Jev which row
-- of data_questions a message matches. When Jev is confident and the row is active, it runs the
-- row's function and replies with the figure, what it counts, where it came from and how old it
-- is. Anything else goes to the agents exactly as before.
--
-- WHAT IS HERE.
--   data_questions               the catalogue. Every row is offered to Jev so it can tell the
--                                questions apart; only active rows are answered, the rest are
--                                logged as demand.
--   data_question_log            every decision the front door makes, answered or not.
--   stock_feed_freshness()       how old each Xero stock feed is, and whether it is overdue.
--   data_answer_stock_on_hand()  barriers on hand by depot, with each depot's source and age.
--
-- All of it is service_role only.

-- ---------------------------------------------------------------------------
-- 1. The catalogue
-- ---------------------------------------------------------------------------

create table if not exists public.data_questions (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  description text not null,
  answer_function text,
  active boolean not null default false,
  min_confidence numeric not null default 0.8 check (min_confidence > 0 and min_confidence <= 1),
  definition text,
  owner text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_questions_active_needs_function check (not active or answer_function is not null)
);

comment on table public.data_questions is
  'The catalogue the CORTEX front door offers to Jev. Only active rows are answered; the others help Jev tell questions apart and are logged as demand.';
comment on column public.data_questions.description is
  'What Jev reads. It answers the question as written, so name every way the question is asked.';
comment on column public.data_questions.definition is
  'What the answer counts and leaves out, in the words the answer uses. The owner signs this off.';

insert into public.data_questions (key, description, answer_function, active, min_confidence, definition, owner) values
  ('stock_on_hand',
   'Asks how much finished product is physically in stock right now: barriers, or a model such as H8, H9, H9X, H10, EU3.5 or the Noise Defender range, at one depot, one country, or across all of them.',
   'data_answer_stock_on_hand', true, 0.8,
   'Barriers are the H8, H9 (with the H9W), H9X, H10, EU3.5 and HT3.5, and the Noise Defender range, which is the grouping the UK daily stock report uses. Hooks, bungees, fitting kits, cutting stations, generator sets, V1 and V2 are left out.',
   'operations'),
  ('stock_in_transit',
   'Asks what stock is on the water or in transit to a region, which containers are coming, or when a shipment or container arrives.',
   null, false, 0.8, null, 'operations'),
  ('material_cover',
   'Asks whether there is enough raw material or components to manufacture a stated quantity of a model, that is, whether a given production order can be built from material in stock.',
   null, false, 0.8, null, 'operations'),
  ('open_pipeline',
   'Asks for the value or count of the open sales pipeline, deals still in progress, for a period, quarter, currency or region.',
   null, false, 0.8, null, 'sales'),
  ('quotes_and_sales_count',
   'Asks how many quotes were sent, and their value, and how many deals were won in a stated period, optionally per company or organisation.',
   null, false, 0.8, null, 'sales')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The decision log
-- ---------------------------------------------------------------------------

create table if not exists public.data_question_log (
  id bigint generated always as identity primary key,
  asked_at timestamptz not null default now(),
  channel text not null default 'buzz',
  agent text,
  asker text,
  message text not null,
  choice text,
  confidence numeric,
  params jsonb,
  mode text not null check (mode in ('live', 'shadow')),
  answered boolean not null default false,
  answer text,
  dedupe_key text,
  error text,
  latency_ms integer
);

create index if not exists idx_data_question_log_asked_at on public.data_question_log (asked_at desc);

-- A message that mentions two agents reaches the front door once per agent. The first live answer
-- claims the message; the second agent's insert conflicts, and that agent stays silent.
create unique index if not exists uq_data_question_log_dedupe
  on public.data_question_log (dedupe_key) where dedupe_key is not null;

comment on table public.data_question_log is
  'Every CORTEX front door decision. mode shadow means the agents still answered; answered says whether the front door had an answer.';

-- ---------------------------------------------------------------------------
-- 3. Stock feed freshness
-- ---------------------------------------------------------------------------

create or replace function public.stock_feed_freshness()
returns table (org text, depot text, place text, last_synced_at timestamptz, age_hours numeric, overdue boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- The three organisations whose stock reaches the Hub from Xero once a day. A feed is overdue
  -- when its newest snapshot is more than 26 hours old: each runs daily between 05:30 and 07:00
  -- UTC, and the extra two hours absorb a late run. The ledger's own updated_at cannot be used,
  -- because every sync re-stamps every Xero-fed row, whether its figure is new or not.
  with feeds (org, depot, place) as (
    values ('UK', 'GB-BSE', 'UK depot'), ('FRANCE', 'EU-FR', 'France depot'), ('GROUP', 'EB-GROUP', 'Group')
  ),
  newest as (
    select s.xero_org, max(s.synced_at) as synced_at
    from public.xero_stock_snapshot s
    group by s.xero_org
  )
  select f.org, f.depot, f.place, n.synced_at,
         round((extract(epoch from (now() - n.synced_at)) / 3600.0)::numeric, 1),
         coalesce(n.synced_at < now() - interval '26 hours', true)
  from feeds f
  left join newest n on n.xero_org = f.org
  order by f.org;
$$;

-- ---------------------------------------------------------------------------
-- 4. Barriers on hand
-- ---------------------------------------------------------------------------

create or replace function public.data_answer_stock_on_hand(p_region text default 'all', p_family text default 'all_barriers')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_region text := lower(coalesce(nullif(trim(p_region), ''), 'all'));
  v_family text := lower(coalesce(nullif(trim(p_family), ''), 'all_barriers'));
  v_all_depots text[] := array['GB-BSE', 'EU-FR', 'EB-GROUP', 'US-BAL', 'US-SBD', 'CA-HAM', 'EB-SRO'];
  v_barriers text[] := array['H8', 'H9', 'H9X', 'H10', 'EU3.5', 'Noise Defender'];
  v_depots text[];
  v_families text[];
  v_result jsonb;
begin
  v_depots := case v_region
    when 'uk' then array['GB-BSE']
    when 'france' then array['EU-FR']
    when 'usa' then array['US-BAL', 'US-SBD']
    when 'canada' then array['CA-HAM']
    when 'group' then array['EB-GROUP']
    when 'factory_slovakia' then array['EB-SRO']
    when 'australia' then array[]::text[]
    else v_all_depots
  end;
  v_families := case v_family
    when 'h8' then array['H8']
    when 'h9' then array['H9']
    when 'h9x' then array['H9X']
    when 'h10' then array['H10']
    when 'eu35' then array['EU3.5']
    when 'noise_defender' then array['Noise Defender']
    else v_barriers
  end;

  with family_of as (
    -- A SKU's family from whichever depot maps it. The factory's rows use North America codes
    -- and have no mapping row of their own, so a per-depot join would leave them unclassified.
    select distinct on (m.hubspot_sku_code) m.hubspot_sku_code as sku, m.product_family
    from public.product_depot_mapping m
    where m.hubspot_sku_code is not null and m.product_family is not null
    order by m.hubspot_sku_code, m.is_active desc, m.updated_at desc
  ),
  depot (code, place, xero_fed, sort) as (
    values ('GB-BSE', 'UK depot', true, 1), ('EU-FR', 'France depot', true, 2),
           ('EB-GROUP', 'Group', true, 3), ('US-BAL', 'Baltimore', false, 4),
           ('US-SBD', 'San Bernardino', false, 5), ('CA-HAM', 'Hamilton', false, 6),
           ('EB-SRO', 'the factory in Slovakia', false, 7)
  ),
  stock as (
    select w.warehouse_code, w.quantity_on_hand, coalesce(f.product_family, 'unclassified') as family
    from public.warehouse_stock_levels w
    left join family_of f on f.sku = w.sku
    where w.warehouse_code = any (v_depots)
  ),
  fresh as (
    select * from public.stock_feed_freshness()
  ),
  per_depot as (
    select d.code, d.place, d.sort, d.xero_fed,
           coalesce(sum(s.quantity_on_hand) filter (where s.family = any (v_families)), 0)::int as units,
           fr.last_synced_at,
           coalesce(fr.overdue, false) as overdue
    from depot d
    left join stock s on s.warehouse_code = d.code
    left join fresh fr on fr.depot = d.code
    where d.code = any (v_depots)
    group by d.code, d.place, d.sort, d.xero_fed, fr.last_synced_at, fr.overdue
  ),
  per_family as (
    select s.family, sum(s.quantity_on_hand)::int as units
    from stock s
    where s.family = any (v_families)
    group by s.family
  )
  select jsonb_build_object(
    'read_at', now(),
    'region', v_region,
    'family', v_family,
    'total', coalesce((select sum(p.units) from per_depot p), 0),
    'depots', coalesce((select jsonb_agg(jsonb_build_object(
        'place', p.place,
        'units', p.units,
        'source', case when p.xero_fed then 'xero' else 'hub' end,
        'last_synced_at', p.last_synced_at,
        'overdue', p.overdue) order by p.sort) from per_depot p), '[]'::jsonb),
    'by_family', coalesce((select jsonb_object_agg(pf.family, pf.units) from per_family pf), '{}'::jsonb),
    'left_out_units', coalesce((select sum(s.quantity_on_hand) from stock s
                                where not (s.family = any (v_families))), 0),
    'unclassified_units', coalesce((select sum(s.quantity_on_hand) from stock s
                                    where s.family = 'unclassified'), 0),
    'australia_asked', v_region in ('all', 'australia'),
    'definition', (select q.definition from public.data_questions q where q.key = 'stock_on_hand')
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Access: service_role only. New tables are born with anon and authenticated holding full
--    DML, which row level security does not cover, so it is revoked explicitly.
-- ---------------------------------------------------------------------------

alter table public.data_questions enable row level security;
alter table public.data_question_log enable row level security;
revoke all on table public.data_questions from anon, authenticated;
revoke all on table public.data_question_log from anon, authenticated;
revoke all on sequence public.data_question_log_id_seq from anon, authenticated;

revoke all on function public.stock_feed_freshness() from public, anon, authenticated;
grant execute on function public.stock_feed_freshness() to service_role;
revoke all on function public.data_answer_stock_on_hand(text, text) from public, anon, authenticated;
grant execute on function public.data_answer_stock_on_hand(text, text) to service_role;
