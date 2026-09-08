import type { PurchaseOrder } from "./erp-types";

/**
 * The PO board's leg-based lifecycle kanban.
 *
 * DEMO SCHEME (Dean, 2026-07-13), placement rules revised 2026-09-08 for the
 * SRO fulfilment step. The final column set is to be confirmed with Juraj and
 * Dave. Columns follow the intercompany legs, then the manufacturing and
 * shipping stages:
 *   Depot → Group → S.R.O → Sent to manufacturing → Manufacturing in progress → Shipping
 *
 * A PO's column is its `lifecycle_stage` when set (persisted on drag), else it is
 * DERIVED from what has actually happened to it, so existing POs place sensibly
 * with no backfill. The stage is a presentation layer: moving a card never
 * mutates the `status` machine (see the set_po_lifecycle_stage migration).
 *
 * Pure data/types, safe to import from both client and server.
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

/** What the board knows about a PO when it places it. */
type StageInput = Pick<PurchaseOrder, "leg" | "status"> & Partial<Pick<PurchaseOrder, "manufacturing">>;

/**
 * Initial column for a PO with no explicit `lifecycle_stage`.
 *
 * The intercompany order is ONE order making its way to SRO, and its rows are
 * the legs of that journey. Group → S.R.O holds the SRO leg only while SRO have
 * not yet accepted it. From approval onward it is SRO's to deal with, whether
 * they are still choosing, fulfilling it from stock, or have raised the Bamida
 * order, so it sits at S.R.O and stays there. The Bamida order is what travels
 * onward, and it moves on the events Bamida themselves produce: the Hub sent it
 * to them, they gave their dates, they pressed finished.
 */
export function deriveStage(po: StageInput): LifecycleStage {
  if (po.status === "shipped" || po.status === "delivered") return "shipping";

  switch (po.leg) {
    case "DEPOT_TO_EB_GROUP":
      return "depot_group";
    case "EB_GROUP_TO_SRO":
      // Requested, or refused: SRO have not taken it.
      return po.status === "requested" || po.status === "rejected" ? "group_sro" : "sro";
    case "SRO_TO_CARGO":
      // The transport leg represents the shipping arrangement.
      return "shipping";
    case "SRO_TO_SUPPLIER":
    default: {
      // Nothing Bamida have said counts until the order has actually been sent
      // to them; a date entered against an unsent order is a test artefact.
      const m = po.manufacturing;
      if (!m?.sent_at) return "sro";
      if (m.finished_at) return "shipping";
      if (m.est_start || m.est_finish) return "manufacturing";
      return "sent_manufacturing";
    }
  }
}

/** The column a PO renders in: its persisted stage, else the derived one. */
export function effectiveStage(po: StageInput & Pick<PurchaseOrder, "lifecycle_stage">): LifecycleStage {
  return isLifecycleStage(po.lifecycle_stage) ? po.lifecycle_stage : deriveStage(po);
}
