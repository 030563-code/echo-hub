-- Rollback for 20260902003000_deals_registry_delivery_guards.sql.
-- Dropping a CHECK takes ACCESS EXCLUSIVE briefly but scans nothing.

alter table public.deals_registry
  drop constraint if exists deals_registry_delivery_complete_ck,
  drop constraint if exists deals_registry_delivery_nonblank_ck,
  drop constraint if exists deals_registry_delivery_state_ck,
  drop constraint if exists deals_registry_delivery_zip_ck,
  drop constraint if exists deals_registry_delivery_country_ck;
