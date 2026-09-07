-- ============================================================================
-- Security: close the anon DML exposure on the 11 MRP/Bamida tables + 2 shadow
-- views. Each object already has RLS enabled and a read policy, but none of the
-- MRP migrations issued the grant-hardening pair the rest of the Hub uses
-- (20260624000500, 20260625000100, 20260709000000) — so the default
-- anon/authenticated table grants were never revoked. TRUNCATE is NOT gated by
-- RLS, so anon could truncate all 11 tables; mrp_shadow_reds is additionally
-- auto-updatable, so anon held DML through the view as well. Target: ops
-- korylyniwsqtsvzuzydg (shared).
--
-- Safe: the Hub reads and writes every one of these through the service_role
-- client (src/lib/supabase/admin.ts — engine-data.ts, settle-po.ts, v2-data.ts,
-- scripts/*), which bypasses RLS and keeps its implicit access. Read-only for
-- authenticated (matching the existing SELECT policies, which stay the gate on
-- WHICH rows); nothing for anon.
-- ============================================================================

-- Demand + stage capture ------------------------------------------------------
revoke all on public.mrp_demand_events    from anon, authenticated;
grant select on public.mrp_demand_events    to authenticated;

revoke all on public.deal_stage_history    from anon, authenticated;
grant select on public.deal_stage_history    to authenticated;

revoke all on public.mrp_stage_weights     from anon, authenticated;
grant select on public.mrp_stage_weights     to authenticated;

-- Lead time + BOM -------------------------------------------------------------
revoke all on public.mrp_lead_time_actuals from anon, authenticated;
grant select on public.mrp_lead_time_actuals to authenticated;

revoke all on public.mrp_bom_map           from anon, authenticated;
grant select on public.mrp_bom_map           to authenticated;

-- Buffer engine ---------------------------------------------------------------
revoke all on public.mrp_buffer_profile      from anon, authenticated;
grant select on public.mrp_buffer_profile      to authenticated;

revoke all on public.mrp_buffer_status_daily from anon, authenticated;
grant select on public.mrp_buffer_status_daily to authenticated;

revoke all on public.mrp_spike_register      from anon, authenticated;
grant select on public.mrp_spike_register      to authenticated;

revoke all on public.mrp_ddsop_log           from anon, authenticated;
grant select on public.mrp_ddsop_log           to authenticated;

-- Bamida material stock -------------------------------------------------------
revoke all on public.bamida_material_stock         from anon, authenticated;
grant select on public.bamida_material_stock         to authenticated;

revoke all on public.bamida_material_stock_history from anon, authenticated;
grant select on public.bamida_material_stock_history to authenticated;

-- Shadow views ----------------------------------------------------------------
-- Both are security_invoker=true, so the base-table revokes above already stop
-- anon reading through them — but the views carry their own grants, and
-- mrp_shadow_reds is auto-updatable (single base table, no aggregation), which
-- means the inherited INSERT/UPDATE/DELETE were real write paths. Revoke both.
revoke all on public.mrp_shadow_flap from anon, authenticated;
grant select on public.mrp_shadow_flap to authenticated;

revoke all on public.mrp_shadow_reds from anon, authenticated;
grant select on public.mrp_shadow_reds to authenticated;
