-- Rollback for 20260917260000_model_spec.sql
--
-- The -1 document degrades to what it printed before: materials, pallet count and the word
-- "Standard" for printing. loadModelSpecs() returns an empty map when the table is gone only if
-- the read errors cleanly; revert the code alongside this rather than relying on that.
drop policy if exists "hub: write model_spec" on public.model_spec;
drop policy if exists "hub: read model_spec" on public.model_spec;
drop index if exists public.idx_model_spec_confirmed;
drop table if exists public.model_spec;
