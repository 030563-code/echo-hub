drop trigger if exists trg_user_page_state_row_cap on public.user_page_state;
drop function if exists public.user_page_state_row_cap();
alter table public.user_page_state drop constraint if exists user_page_state_base_length;
