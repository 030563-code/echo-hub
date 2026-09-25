-- The CORTEX front door's second question: what stock is on the way, and when does it land.
--
-- WHERE IT COMES FROM. Position and dates come from cargo_shipment (joined to cargo_container on
-- spot_id), synced from Cargo Partner, which Dean made the source of truth for shipments on 25
-- September 2026. Its eta is the arrival at the port of discharge; the last leg to the depot has
-- no date in the feed. What is in each container comes from eb_operations.shipments, the container
-- shipment sheet synced each morning, because Cargo Partner only counts packages. That sheet's
-- eta_depot column is not used: it holds the port date under a depot name.
--
-- A shipment is open until Cargo Partner marks it complete or delivered. Containers that have not
-- sailed yet (picked up, gate in) are listed as not sailed, never as on the water.

create or replace function public.data_answer_stock_in_transit(p_region text default 'all', p_family text default 'all_barriers')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_region text := lower(coalesce(nullif(trim(p_region), ''), 'all'));
  v_family text := lower(coalesce(nullif(trim(p_family), ''), 'all_barriers'));
  v_barriers text[] := array['H8', 'H9', 'H9X', 'H10', 'EU3.5', 'Noise Defender'];
  v_families text[];
  v_result jsonb;
begin
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
    select distinct on (lower(m.xero_item_code)) lower(m.xero_item_code) as code, m.product_family
    from public.product_depot_mapping m
    where m.xero_item_code is not null and m.product_family is not null
    order by lower(m.xero_item_code), m.is_active desc, m.updated_at desc
  ),
  open_shipments as (
    select s.spot_id, s.destination_depot, s.destination_city, s.departed_on, s.eta,
           s.current_status, s.current_status_on,
           (select string_agg(c.container_number, ', ' order by c.container_index)
              from public.cargo_container c where c.spot_id = s.spot_id) as containers,
           case
             when s.destination_depot in ('US-BAL', 'US-SBD') then 'usa'
             when s.destination_depot = 'CA-HAM' then 'canada'
             when s.destination_depot like 'GB-%' then 'uk'
             when s.destination_depot like 'EU-FR%' then 'france'
             when s.destination_depot like 'AU-%' then 'australia'
             when s.destination_depot = 'EB-SRO' then 'factory_slovakia'
             when s.destination_depot = 'EB-GROUP' then 'group'
             else 'other'
           end as region
    from public.cargo_shipment s
    where not coalesce(s.is_complete, false) and s.delivered_on is null
  ),
  contents as (
    select e.spot_id, coalesce(f.product_family, 'unclassified') as family, sum(e.no_of_barriers)::int as units
    from eb_operations.shipments e
    left join family_of f on f.code = lower(e.barrier_type)
    where e.spot_id in (select o.spot_id from open_shipments o)
    group by e.spot_id, coalesce(f.product_family, 'unclassified')
  ),
  per_shipment as (
    select o.*,
           coalesce((select sum(c.units) from contents c
                     where c.spot_id = o.spot_id and c.family = any (v_families)), 0)::int as units,
           (select jsonb_object_agg(c.family, c.units) from contents c where c.spot_id = o.spot_id) as by_family,
           exists (select 1 from contents c where c.spot_id = o.spot_id) as contents_known
    from open_shipments o
    where v_region = 'all' or o.region = v_region
  ),
  shown as (
    select * from per_shipment p where p.units > 0 or not p.contents_known
  )
  select jsonb_build_object(
    'read_at', now(),
    'region', v_region,
    'family', v_family,
    'total', coalesce((select sum(p.units) from shown p), 0),
    'shipments', coalesce((select jsonb_agg(jsonb_build_object(
        'containers', p.containers,
        'place', coalesce(case p.destination_depot
                            when 'US-BAL' then 'Baltimore' when 'US-SBD' then 'San Bernardino'
                            when 'CA-HAM' then 'Hamilton' when 'EB-SRO' then 'the factory in Slovakia'
                            when 'EB-GROUP' then 'Group' end,
                          p.destination_city, p.destination_depot),
        'sailed', p.departed_on is not null,
        'departed_on', p.departed_on,
        'eta_port', p.eta,
        'status', p.current_status,
        'status_on', p.current_status_on,
        'units', p.units,
        'by_family', coalesce(p.by_family, '{}'::jsonb),
        'contents_known', p.contents_known) order by p.eta nulls last) from shown p), '[]'::jsonb),
    'cargo_synced_at', (select max(s.synced_at) from public.cargo_shipment s),
    'contents_synced_at', (select max(e.updated_at) from eb_operations.shipments e)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.data_answer_stock_in_transit(text, text) from public, anon, authenticated;
grant execute on function public.data_answer_stock_in_transit(text, text) to service_role;

update public.data_questions
set answer_function = 'data_answer_stock_in_transit',
    definition = 'Stock on the way to a depot: every open Cargo Partner shipment, with what is in it from the container shipment sheet. Dates are arrival at the port of discharge; the last leg to the depot has no date. Containers that have not sailed yet are listed as not sailed.',
    updated_at = now()
where key = 'stock_in_transit';
