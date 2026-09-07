-- Bounds on what one person can accumulate here.
--
-- savePageState is a 'use server' export, which means it is a callable endpoint
-- for anyone with a session, and the two things it did not bound were the
-- `base` fingerprint (which sits outside the size CHECK on `state`) and the
-- NUMBER of keys one user can create. Neither is a likely accident, but a
-- public write endpoint with no ceiling is not something to leave open.
--
-- The row cap is a BEFORE INSERT trigger rather than a check in the action, so
-- it costs nothing on the common path: a page saving as you type is an UPDATE
-- of a row that already exists, and the trigger never fires. Only claiming a
-- NEW key pays for the count, which is an index lookup on the primary key's
-- leading column.

alter table public.user_page_state
  drop constraint if exists user_page_state_base_length;
alter table public.user_page_state
  add constraint user_page_state_base_length
  check (base is null or length(base) <= 400);

create or replace function public.user_page_state_row_cap()
returns trigger
language plpgsql
security invoker
-- Empty search_path with fully qualified names: the advisor flags a mutable
-- search_path on any function, and this one is reached from a public endpoint.
set search_path = ''
as $$
declare
  n integer;
begin
  select count(*) into n
    from public.user_page_state
   where user_id = new.user_id;

  -- Generous: the whole Hub is about twenty view keys, plus one draft per deal
  -- somebody is actually mid-quote on. Hitting this means a loop, not a rep.
  if n >= 100 then
    raise exception 'user_page_state row cap reached'
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

comment on function public.user_page_state_row_cap() is
  'Caps saved pages per user at 100. Fires only on INSERT, so saving an existing page costs nothing.';

drop trigger if exists trg_user_page_state_row_cap on public.user_page_state;
create trigger trg_user_page_state_row_cap
  before insert on public.user_page_state
  for each row execute function public.user_page_state_row_cap();
