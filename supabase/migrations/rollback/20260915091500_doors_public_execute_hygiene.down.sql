-- Puts the blanket PUBLIC execute grant back on the nine functions.
-- Only needed if some unnamed role turns out to have depended on it; every role
-- that exists today holds an explicit grant and is unaffected either way.
grant execute on function public.is_super_admin()              to public;
grant execute on function public.can_read_po()                 to public;
grant execute on function public.notify_po_phase1()            to public;
grant execute on function public.notify_po_phase2()            to public;
grant execute on function public.stock_on_booking()            to public;
grant execute on function public.po_before_insert()            to public;
grant execute on function public.po_guard_number_update()      to public;
grant execute on function public.capture_deal_stage_change()   to public;
grant execute on function public.profiles_guard_authz_columns() to public;
revoke execute on function public.is_super_admin() from dashboard_user;
revoke execute on function public.can_read_po()    from dashboard_user;
