import type { PurchaseOrder } from "./erp-types";

/**
 * The PO board's leg-based lifecycle kanban.
 *
 * DEMO SCHEME (Dean, 2026-07-13) — the final column set is to be confirmed with
 * Juraj + Dave. Columns follow the intercompany legs, then the manufacturing +
 * shipping stages:
 *   Depot → Group → S.R.O → Sent to manufacturing → Manufacturing in progress → Shipping
 *
 * A PO's column is its `lifecycle_stage` when set (persisted on drag), else it is
 * DERIVED from leg+status so existing POs place sensibly with no backfill. The
 * stage is a presentation layer — moving a card never mutates the `status`
 * machine (see the set_po_lifecycle_stage migration).
 *
 * Pure data/types — safe to import from both client and server.
 */

export const LIFECYCLE_STAGES = [
  { key: "depot_group", label: "Depot → Group" },
  { key: "group_sro", label: "Group → S.R.O" },
  { key: "sro", label: "S.R.O" },
  { key: "sent_manufacturing", label: "Sent to manufacturing" },
  { key: "manufacturing", label: "Manufacturing in progress" },
  { key: "shipping", label: "Shipping" },
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]["key"];

export const LIFECYCLE_STAGE_KEYS = LIFECYCLE_STAGES.map((s) => s.key) as LifecycleStage[];

export function isLifecycleStage(v: unknown): v is LifecycleStage {
  return typeof v === "string" && (LIFECYCLE_STAGE_KEYS as string[]).includes(v);
}

export function stageLabel(stage: LifecycleStage): string {
  return LIFECYCLE_STAGES.find((s) => s.key === stage)?.label ?? stage;
}

type StageInput = Pick<PurchaseOrder, "leg" | "status">;

/**
 * Initial column for a PO with no explicit `lifecycle_stage`. Status wins for the
 * manufacturing/shipping stages (so a PO already in_manufacturing/shipped lands in
 * the right place); otherwise the leg decides the intercompany column.
 */
export function deriveStage(po: StageInput): LifecycleStage {
  if (po.status === "shipped" || po.status === "delivered") return "shipping";
  if (po.status === "in_manufacturing") return "manufacturing";

  switch (po.leg) {
    case "DEPOT_TO_EB_GROUP":
      return "depot_group";
    case "EB_GROUP_TO_SRO":
      return "group_sro";
    case "SRO_TO_CARGO":
      // The transport leg represents the shipping arrangement.
      return "shipping";
    case "SRO_TO_SUPPLIER":
    default:
      // The Bamida manufacturing PO lands "at S.R.O" — it is dragged onward
      // (Sent to manufacturing → In progress → Shipping) from there.
      return "sro";
  }
}

/** The column a PO renders in: its persisted stage, else the derived one. */
export function effectiveStage(po: Pick<PurchaseOrder, "leg" | "status" | "lifecycle_stage">): LifecycleStage {
  return isLifecycleStage(po.lifecycle_stage) ? po.lifecycle_stage : deriveStage(po);
}
