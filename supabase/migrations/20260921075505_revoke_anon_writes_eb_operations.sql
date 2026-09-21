-- 2026-09-21. Found while tracing why the COO could not read stock for Andrew on 18 September.
-- The anon key ships in the Hub's browser bundle (NEXT_PUBLIC_SUPABASE_ANON_KEY), so anyone who
-- opens the Hub holds it. On these four eb_operations tables both anon and authenticated held
-- TRUNCATE, DELETE and UPDATE. TRUNCATE is not governed by row-level security, so either role
-- could empty them regardless of policy. No application in any repo truncates, deletes or
-- updates these tables: the Hub writes purchase_orders.lifecycle_stage through the SECURITY
-- DEFINER set_po_lifecycle_stage RPC, and nothing references pick_lists at all.
--
-- Left deliberately in place: anon INSERT and SELECT where an explicit policy exists (the
-- pick-list submission path), and anon SELECT on inventory_snapshot and shipments, which is the
-- COO's documented PostgREST fallback. Those reads are open to anyone holding the anon key and
-- are flagged for a separate decision.
--
-- Applied live via the Supabase MCP apply_migration as revoke_anon_writes_eb_operations and
-- mirrored here. Rollback: rollback/20260921075505_revoke_anon_writes_eb_operations.down.sql

revoke truncate on
  eb_operations.po_lifecycle,
  eb_operations.pick_lists,
  eb_operations.pick_list_items,
  eb_operations.pick_list_config
from anon, authenticated;

revoke delete, update on
  eb_operations.po_lifecycle,
  eb_operations.pick_lists,
  eb_operations.pick_list_items,
  eb_operations.pick_list_config
from anon;

-- Blanket read/write policy on a table with no rows and no application reader. With row-level
-- security on and no remaining anon policy, anon now sees nothing here.
drop policy if exists "Allow anon all" on eb_operations.po_lifecycle;
