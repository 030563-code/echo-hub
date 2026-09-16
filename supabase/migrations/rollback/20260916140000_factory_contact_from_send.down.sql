-- Rollback of 20260916140000_factory_contact_from_send.sql.
--
-- Dropping these columns sends the confirmation email back to the address of
-- the Hub account that pressed Confirm. Check that account is a mailbox the
-- manufacturer actually reads before running this, or their receipt and the
-- invoice reminder on it go to nobody.

alter table public.po_manufacturing drop column if exists intended_cc;
alter table public.po_manufacturing drop column if exists intended_to;
