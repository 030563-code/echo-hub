"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { getAuthorizedUser } from "@/lib/authz";
import { LIFECYCLE_STAGE_KEYS } from "@/lib/po-lifecycle";

// ---------------------------------------------------------------------------
// Move a PO to a lifecycle-kanban column (demo board: Depot → Group → S.R.O →
// Sent to manufacturing → Manufacturing in progress → Shipping).
//
// The write goes through the SECURITY DEFINER `set_po_lifecycle_stage` RPC, which
// re-checks po.approve OR po.receive server-side (auth.uid()). We ALSO gate here
// so the UI never even attempts an unauthorised move. The stage is presentation
// only — it never mutates the PO `status` machine.
// ---------------------------------------------------------------------------

const StageSchema = z.object({
  poId: z.string().uuid("Invalid PO id"),
  stage: z.enum(LIFECYCLE_STAGE_KEYS as [string, ...string[]]),
});

export type SetPoStageInput = z.infer<typeof StageSchema>;
export type SetPoStageResult = { success: true } | { success: false; error: string };

export async function setPoStage(input: SetPoStageInput): Promise<SetPoStageResult> {
  const auth = await getAuthorizedUser();
  if (!auth.ok) return { success: false, error: auth.error };
  if (!auth.capabilities.has("po.approve") && !auth.capabilities.has("po.receive")) {
    return { success: false, error: "Forbidden: requires po.approve or po.receive" };
  }

  const parsed = StageSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { poId, stage } = parsed.data;

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("set_po_lifecycle_stage", { p_po_id: poId, p_stage: stage });
  if (error) {
    console.error("setPoStage failed", error.message);
    return { success: false, error: "Could not move the purchase order." };
  }

  revalidatePath("/purchase-orders");
  return { success: true };
}
