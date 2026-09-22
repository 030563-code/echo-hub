-- Undo 20260922100000_po_priced_document.sql
--
-- 🔴 DESTRUCTIVE. Dropping this table destroys every hand-edited priced order and every sign-off
-- on one, which exist nowhere else. Take a copy first if any row has been confirmed:
--
--   create table public.po_priced_document_backup as select * from public.po_priced_document;

drop trigger if exists po_priced_document_touch on public.po_priced_document;
drop table if exists public.po_priced_document;
drop function if exists public.trg_po_priced_document_touch();
