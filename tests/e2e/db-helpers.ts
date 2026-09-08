import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role access for fixtures and cleanup only. playwright.config.ts loads
 * .env.local into process.env, so this works against whatever server the run
 * points at. Null when the key is not configured, and the spec self-skips.
 */
export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Delete every purchase order whose notes equal `notes`, leaves first, so a
 * whole chain (root, group leg, SRO leg, Bamida order) comes out whatever the
 * parent_po_id constraint does on delete. Lines, receipts, po_manufacturing and
 * access tokens cascade from the order. Returns how many orders went.
 */
export async function deletePurchaseOrdersByNotes(sb: SupabaseClient, notes: string): Promise<number> {
  let removed = 0;
  for (let pass = 0; pass < 6; pass++) {
    const { data: rows } = await sb.from("purchase_orders").select("id").eq("notes", notes);
    if (!rows?.length) break;
    const ids = rows.map((r) => r.id as string);
    const { data: parents } = await sb.from("purchase_orders").select("parent_po_id").in("parent_po_id", ids);
    const withChildren = new Set((parents ?? []).map((p) => p.parent_po_id as string));
    const leaves = ids.filter((id) => !withChildren.has(id));
    const { error } = await sb.from("purchase_orders").delete().in("id", leaves);
    if (error) throw error;
    removed += leaves.length;
  }
  return removed;
}
