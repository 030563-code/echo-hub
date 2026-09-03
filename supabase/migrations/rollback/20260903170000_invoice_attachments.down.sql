-- Rollback for 20260903170000_invoice_attachments.sql.
--
-- Refuses while the bucket still holds objects. Dropping the table would orphan
-- every file with no record of which invoice it belonged to or what it was
-- called, and Storage would keep serving them to anyone holding a live signed
-- url. Empty the bucket first, deliberately, then run this.
do $$
declare
  remaining bigint;
begin
  select count(*) into remaining from storage.objects where bucket_id = 'invoice-attachments';
  if remaining > 0 then
    raise exception
      'invoice-attachments still holds % object(s). Delete them first: dropping invoice_attachments would orphan the files.', remaining;
  end if;
end $$;

drop table if exists public.invoice_attachments;

delete from storage.buckets where id = 'invoice-attachments';
