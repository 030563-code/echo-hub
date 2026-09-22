-- Undo 20260922200000_uk_and_group_are_01_prefixed_only.
--
-- 🔴 The deleted rows are NOT restored by this, and do not need to be: the next hourly sync
-- recreates whatever the rules then allow. What this does is put the rules back, so the UK and
-- Group stop being restricted to the 01- prefix and the sync starts recording the other 19,900
-- codes again, including the hire fleet.
--
-- Dean called those deprecated. Do not run this unless that has changed.

delete from public.xero_org_depot_rule where xero_org in ('UK', 'GROUP') and code_pattern = '^01-';

update public.xero_org_depot_rule
set is_excluded = false, note = 'One depot'
where xero_org in ('UK', 'GROUP') and code_pattern is null;

create or replace function public.depot_for_xero_item(p_xero_org text, p_item_code text)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select r.depot_code
  from public.xero_org_depot_rule r
  where upper(r.xero_org) = upper(coalesce(p_xero_org, ''))
    and (r.code_pattern is null or coalesce(p_item_code, '') ~* r.code_pattern)
  order by r.priority
  limit 1;
$$;

drop function if exists public.xero_item_rule(text, text);
alter table public.xero_org_depot_rule drop column if exists is_excluded;

do $$
begin
  raise notice 'Rules restored. Re-apply 20260922190000_orderable_needs_an_account.sql for the previous commit function, then let the hourly sync repopulate.';
end $$;
