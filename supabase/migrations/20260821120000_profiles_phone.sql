-- The quote PDF prints the rep's direct number twice (in the quote meta block
-- and under "Questions? Contact me"), matching the HubSpot-native quote it was
-- rebuilt against. profiles held no phone, so that line was silently dropped.
--
-- Deliberately NOT granted UPDATE to authenticated: profiles only grants
-- column-level UPDATE on display_name, so a rep cannot rewrite the number that
-- goes out on a customer-facing document. A super admin sets it.
alter table public.profiles add column if not exists phone text;

comment on column public.profiles.phone is
  'Rep''s direct line as printed on quote PDFs. Set by a super admin; no authenticated UPDATE grant.';
