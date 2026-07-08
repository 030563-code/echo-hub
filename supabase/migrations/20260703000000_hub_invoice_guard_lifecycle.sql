-- Commercial-invoice hardening:
-- 1) DB-level duplicate guard — at most ONE live (non-void) invoice per
--    (container_ref, leg). The app pre-checks too, but this closes the race and
--    makes a repeat generation impossible even via the raw API. Voided invoices
--    are excluded so a corrected re-issue is allowed after voiding.
-- 2) Lifecycle: status stays a free text column ('draft' | 'issued' | 'void');
--    no schema change needed, just the guard + the app transitions. A CHECK keeps
--    the value sane going forward.

create unique index if not exists commercial_invoices_container_leg_live_uidx
  on public.commercial_invoices (container_ref, leg)
  where status <> 'void';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'commercial_invoices_status_chk'
  ) then
    alter table public.commercial_invoices
      add constraint commercial_invoices_status_chk
      check (status in ('draft', 'issued', 'void'));
  end if;
end $$;
