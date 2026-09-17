-- Rollback for 20260917170000_mrp_per_organisation.sql
--
-- 🔴 This is only safe while every row still carries organisation = 'EB-USA'. Once a second
-- organisation has rows, dropping back to a SKU-only key would fail on the duplicate SKUs, which
-- is the correct outcome: it means the per-organisation engine is live and this rollback is the
-- wrong tool. Delete the other organisations' rows first if that is genuinely what is wanted.
alter table public.mrp_buffer_profile
  drop column if exists deep_from,
  drop column if exists deep_months,
  drop column if exists deep_max_order,
  drop column if exists deep_p95_order,
  drop column if exists deep_cov,
  drop column if exists deep_adu;

alter table public.mrp_buffer_status_daily
  drop constraint if exists mrp_buffer_status_daily_pkey;
alter table public.mrp_buffer_status_daily
  add constraint mrp_buffer_status_daily_pkey primary key (run_date, sku);
alter table public.mrp_buffer_status_daily
  drop column if exists organisation;

alter table public.mrp_buffer_profile
  drop constraint if exists mrp_buffer_profile_alias_of_fkey;
alter table public.mrp_buffer_profile
  drop constraint if exists mrp_buffer_profile_pkey;
alter table public.mrp_buffer_profile
  add constraint mrp_buffer_profile_pkey primary key (sku);
alter table public.mrp_buffer_profile
  add constraint mrp_buffer_profile_alias_of_fkey
  foreign key (alias_of) references public.mrp_buffer_profile (sku);
alter table public.mrp_buffer_profile
  drop column if exists organisation;
