-- Rollback for 20260903150000_deal_quotes_editing.sql
--
-- Any row still sitting at 'editing' has a HubSpot quote parked in DRAFT with
-- no live link. Send those back to 'failed' rather than dropping the status,
-- so the deal page keeps flagging them for a human instead of showing them as
-- published quotes with an empty link.
update public.deal_quotes
   set status = 'failed',
       failed_step = 'republish',
       error_message = coalesce(error_message, 'Left mid-edit when quote editing was rolled back. Republish or regenerate in HubSpot.')
 where status = 'editing';

drop index if exists deal_quotes_one_in_flight;
create unique index deal_quotes_one_in_flight
  on public.deal_quotes (hubspot_deal_id) where status = 'draft';

alter table public.deal_quotes drop constraint deal_quotes_status_check;
alter table public.deal_quotes add constraint deal_quotes_status_check
  check (status in ('draft', 'published', 'failed'));

alter table public.deal_quotes drop column if exists link_before_edit;
alter table public.deal_quotes drop column if exists edit_count;
alter table public.deal_quotes drop column if exists edited_at;
alter table public.deal_quotes drop column if exists recalled_at;
