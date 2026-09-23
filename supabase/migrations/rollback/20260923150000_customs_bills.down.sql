-- Rollback of 20260923150000_customs_bills.sql.
--
-- The bucket is not dropped here: Supabase refuses direct deletes on storage tables. Empty it and
-- delete it from the Storage API (dashboard, Storage, customs-documents) if it must go.

drop table if exists public.customs_bills;
delete from public.user_capabilities where capability = 'customs.manage';
delete from public.capabilities where key = 'customs.manage';
