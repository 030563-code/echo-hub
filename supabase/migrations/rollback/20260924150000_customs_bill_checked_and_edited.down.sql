-- Rollback of 20260924150000_customs_bill_checked_and_edited.sql.
-- Drops the sign-offs and the record of edits. An edited reading stays as edited in extraction;
-- restore extraction from extraction_original first if the edits should go too.
alter table public.customs_bills
  drop column if exists reviewed_checks,
  drop column if exists review_note,
  drop column if exists reviewed_at,
  drop column if exists reviewed_by_uid,
  drop column if exists edited_at,
  drop column if exists edited_by_uid,
  drop column if exists extraction_original;
