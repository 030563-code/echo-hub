-- Take EXECUTE on the public SECURITY DEFINER functions back from PUBLIC, so a
-- new login role (doors_api, and anything added later) does not inherit the
-- right to call them just by existing.
--
-- APPLIED LIVE via MCP apply_migration (doors_public_execute_hygiene) on
-- korylyniwsqtsvzuzydg. This file is the repo mirror. Never `db push`.
--
-- A provable no-op for every role that exists today. Each of these nine already
-- carries explicit grants to anon, authenticated and service_role, and postgres
-- owns them. dashboard_user holds only the PUBLIC grant, so it is granted
-- explicitly first on the two that are callable at all; the other seven return
-- `trigger`, and PostgreSQL checks EXECUTE on a trigger function when the
-- trigger is CREATED, never when it fires, so revoking cannot break a trigger.
-- Verified after applying: anon, authenticated, service_role, dashboard_user and
-- postgres all still hold execute on both callable functions.
--
-- Not exploitable before this change either: is_super_admin() and can_read_po()
-- read auth.uid(), which is null for a role with no JWT, so both returned false.
-- This is about surface, not about a live hole.
--
-- NOT changed here, and still open from the 2026-07-02 audit: anon holds an
-- explicit EXECUTE on is_super_admin and can_read_po. Removing that is a
-- decision about the Hub, not about this gateway, so it stays Dean's call.

grant execute on function public.is_super_admin() to dashboard_user;
grant execute on function public.can_read_po()    to dashboard_user;

revoke execute on function public.is_super_admin()             from public;
revoke execute on function public.can_read_po()                from public;
revoke execute on function public.notify_po_phase1()           from public;
revoke execute on function public.notify_po_phase2()           from public;
revoke execute on function public.stock_on_booking()           from public;
revoke execute on function public.po_before_insert()           from public;
revoke execute on function public.po_guard_number_update()     from public;
revoke execute on function public.capture_deal_stage_change()  from public;
revoke execute on function public.profiles_guard_authz_columns() from public;
