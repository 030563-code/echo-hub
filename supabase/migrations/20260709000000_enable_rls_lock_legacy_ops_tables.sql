-- ============================================================================
-- Security: close the CRITICAL anon exposure on 5 legacy tables (Supabase advisor
-- "RLS Disabled in Public"). RLS was OFF and anon/authenticated held FULL DML
-- incl. TRUNCATE — which RLS does NOT gate — so the grants themselves are revoked,
-- not just RLS enabled. Target: ops korylyniwsqtsvzuzydg (shared).
--
-- Safe: n8n runs as service_role (bypasses RLS + keeps grants) → unaffected; the
-- Hub references none of these (it uses public.purchase_orders, not eb_operations.*).
-- If a LEGACY app read these via the public anon key it will now be blocked — add
-- a scoped read policy if that surfaces.
-- ============================================================================

alter table eb_operations.inventory_snapshot enable row level security;
alter table eb_operations.purchase_orders    enable row level security;
alter table eb_operations.committed_orders   enable row level security;
alter table eb_operations.shipments          enable row level security;
alter table public.deal_tombstones           enable row level security;

revoke all on eb_operations.inventory_snapshot from anon, authenticated;
revoke all on eb_operations.purchase_orders    from anon, authenticated;
revoke all on eb_operations.committed_orders   from anon, authenticated;
revoke all on eb_operations.shipments          from anon, authenticated;
revoke all on public.deal_tombstones           from anon, authenticated;
