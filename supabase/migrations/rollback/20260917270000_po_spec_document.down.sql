-- Undo 20260917270000_po_spec_document.sql
--
-- 🔴 DESTRUCTIVE. Dropping this table destroys every hand-edited manufacturing specification and
-- every sign-off on one, which exist nowhere else: model_spec holds the STANDING values for a
-- model, not what was agreed for one order. Take a copy first if any row has been confirmed:
--
--   create table public.po_spec_document_backup as select * from public.po_spec_document;

drop trigger if exists po_spec_document_touch on public.po_spec_document;
drop table if exists public.po_spec_document;
drop function if exists public.trg_po_spec_document_touch();
