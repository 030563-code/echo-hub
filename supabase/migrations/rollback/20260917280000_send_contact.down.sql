-- Undo 20260917280000_send_contact.sql
--
-- 🔴 DESTRUCTIVE. Any contact added to the address book since the migration is lost, and those
-- exist nowhere else. Take a copy first:
--   create table public.send_contact_backup as select * from public.send_contact;
--
-- The seeded rows are reproducible from the migration; rows a person added are not.

drop table if exists public.send_contact;
