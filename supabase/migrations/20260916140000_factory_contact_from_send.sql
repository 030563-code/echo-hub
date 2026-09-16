-- The confirmation email goes to the address the order was addressed to.
--
-- Dean, 16 Sep 2026: "cant we link an email to a PO by what Juraj put in in
-- that step just before manufacturing?" Yes, and it is the better source. Juraj
-- already types the address on the Send to manufacturing card, because Bamida
-- have several points of contact (his own request, 9 Sep). The right person to
-- receive the confirmation is whoever he addressed the order to, not whichever
-- Hub account happened to press Confirm: that login may be shared, and its
-- address may be one of ours that nobody at the factory reads.
--
-- sent_to already exists, but it records where the email ACTUALLY went, which
-- is the test address while HUB_EMAIL_TEST_RECIPIENT is set. These two columns
-- record the real audience instead, the `intended` lists resolveRecipients
-- hands back. Without them, an order sent during testing and confirmed after
-- testing ends would send its confirmation to whoever was catching test mail.

alter table public.po_manufacturing add column if not exists intended_to text[];
alter table public.po_manufacturing add column if not exists intended_cc text[];

comment on column public.po_manufacturing.intended_to is
  'Who the purchase order was addressed to at the manufacturer, before any test override. The confirmation email goes back here.';
comment on column public.po_manufacturing.intended_cc is
  'Any further manufacturer contacts copied on the purchase order. Copied on the confirmation too.';

-- A real send already recorded its real audience in sent_to, so those rows can
-- be filled in. A test send recorded the test address and the real audience was
-- never stored anywhere, so it stays null and the confirmation falls back to
-- the server's configured address, which is what the send itself falls back to.
update public.po_manufacturing
set intended_to = sent_to
where sent_at is not null
  and coalesce(sent_was_test, false) = false
  and intended_to is null
  and coalesce(array_length(sent_to, 1), 0) > 0;
