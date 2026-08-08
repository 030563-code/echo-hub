-- ============================================================================
-- MRP Task 10 (Part A, revised per the Task 8 review ruling): demand-vocabulary
-- routing via profile ALIASES.
--
-- The demand ledger (mrp_demand_events) is an append-only AUDIT LOG — the SKU
-- spellings in it are historical facts and are NEVER rewritten. Alternate US/CA
-- spellings of the same physical product are instead declared as alias rows on
-- mrp_buffer_profile: the engine rolls an alias row's demand into its
-- alias_of target's ADU/CoV and excludes the alias row itself from buffer
-- computation, status persistence, and spike qualification. Reversible by
-- clearing alias_of — unlike a ledger rewrite.
--
-- Alias rulings (Task 8 reviewer, verified against live data):
--   01-EBH9   -> EBH9NA       UK-vocabulary leak, same code_uk lineage
--   EBH10HERC -> EBH10HERCNA  direct variant spelling of the same product
--   H8        -> EBH8NA       53 units over 3 invoices of real product demand;
--                             ruled an alias (reversible declaration)
--
-- Non-SKU sentinels (NOT stockable products — no buffer rows, ever):
--   NO_SKU_FOUND  line-item parse-failure marker      (excluded at Task 8 seed)
--   Transport     freight service line                (excluded at Task 8 seed)
--   LTLNA         per-invoice Less-Than-Truckload freight charges — 22 demand
--                 events, all qty = 1, one per Xero invoice (verified). Its
--                 profile row is deleted below; any future profile re-seed
--                 must exclude LTLNA alongside NO_SKU_FOUND / Transport.
-- ============================================================================

alter table public.mrp_buffer_profile
  add column alias_of text references public.mrp_buffer_profile(sku),
  add constraint mrp_buffer_profile_alias_not_self
    check (alias_of is null or alias_of <> sku);

comment on column public.mrp_buffer_profile.alias_of is
  'Set on rows that are alternate demand-ledger spellings of another profile '
  'SKU: the engine rolls this row''s demand into alias_of''s ADU/CoV and '
  'EXCLUDES this row from buffer computation. Never aggregate ADU by '
  'family_sku (EBH9NA/EBH9ERNA share a family but are distinct products). '
  'Single-level contract: an alias target must itself have alias_of null.';

update public.mrp_buffer_profile
  set alias_of = 'EBH9NA', updated_at = now()
  where sku = '01-EBH9';

update public.mrp_buffer_profile
  set alias_of = 'EBH10HERCNA', updated_at = now()
  where sku = 'EBH10HERC';

update public.mrp_buffer_profile
  set alias_of = 'EBH8NA', updated_at = now()
  where sku = 'H8';

delete from public.mrp_buffer_profile where sku = 'LTLNA';
