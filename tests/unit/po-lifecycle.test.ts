import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_KEYS,
  deriveStage,
  effectiveStage,
  isLifecycleStage,
  stageLabel,
} from "@/lib/po-lifecycle";
import type { PoManufacturing, PurchaseOrder } from "@/lib/erp-types";

type Leg = PurchaseOrder["leg"];
type Status = PurchaseOrder["status"];
type Input = Pick<PurchaseOrder, "leg" | "status" | "lifecycle_stage" | "manufacturing">;

const po = (
  leg: Leg,
  status: Status,
  lifecycle_stage: PurchaseOrder["lifecycle_stage"] = null,
  manufacturing: PoManufacturing | null = null,
): Input => ({ leg, status, lifecycle_stage, manufacturing });

/** A po_manufacturing row as the board sees it, with only the given facts set. */
const mfg = (over: Partial<PoManufacturing>): PoManufacturing => ({
  sent_at: null,
  sent_was_test: false,
  est_start: null,
  est_finish: null,
  finished_at: null,
  ...over,
});

describe("LIFECYCLE_STAGES", () => {
  it("is the 6-column demo scheme in leg order", () => {
    expect(LIFECYCLE_STAGE_KEYS).toEqual([
      "depot_group",
      "group_sro",
      "sro",
      "sent_manufacturing",
      "manufacturing",
      "shipping",
    ]);
    expect(LIFECYCLE_STAGES.map((s) => s.label)).toEqual([
      "Depot → Group",
      "Group → S.R.O",
      "S.R.O",
      "Sent to manufacturing",
      "Manufacturing in progress",
      "Shipping",
    ]);
  });

  it("stageLabel resolves each key", () => {
    expect(stageLabel("sent_manufacturing")).toBe("Sent to manufacturing");
    expect(stageLabel("shipping")).toBe("Shipping");
  });
});

describe("deriveStage, the intercompany legs", () => {
  it("depot leg stays at Depot → Group", () => {
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "requested"))).toBe("depot_group");
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "approved"))).toBe("depot_group");
  });

  it("the SRO leg is in flight only until SRO accept it", () => {
    expect(deriveStage(po("EB_GROUP_TO_SRO", "requested"))).toBe("group_sro");
    expect(deriveStage(po("EB_GROUP_TO_SRO", "rejected"))).toBe("group_sro");
  });

  it("once approved the SRO order sits at S.R.O, whatever SRO then decide", () => {
    expect(deriveStage(po("EB_GROUP_TO_SRO", "approved"))).toBe("sro");
    expect(deriveStage(po("EB_GROUP_TO_SRO", "sro_evaluating"))).toBe("sro");
    // Fulfilling from stock is SRO's own work: it does not go back to Group → S.R.O.
    expect(deriveStage(po("EB_GROUP_TO_SRO", "fulfilling_from_stock"))).toBe("sro");
    // Choosing to manufacture does not move the SRO order itself into
    // manufacturing; the Bamida order it raised is what travels.
    expect(deriveStage(po("EB_GROUP_TO_SRO", "in_manufacturing"))).toBe("sro");
  });

  it("cargo leg → shipping (the transport arrangement)", () => {
    expect(deriveStage(po("SRO_TO_CARGO", "requested"))).toBe("shipping");
  });

  it("shipped / delivered → shipping regardless of leg", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "shipped"))).toBe("shipping");
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "delivered"))).toBe("shipping");
  });
});

describe("deriveStage, the Bamida order moves on what Bamida do", () => {
  it("raised but not sent: at S.R.O", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved"))).toBe("sro");
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({})))).toBe("sro");
  });

  it("dates against an unsent order do not count", () => {
    expect(
      deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ est_start: "2026-09-09", est_finish: "2026-09-30" }))),
    ).toBe("sro");
  });

  it("sent to Bamida: Sent to manufacturing", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: "2026-09-08T10:00:00Z" })))).toBe(
      "sent_manufacturing",
    );
  });

  it("sent and dated: Manufacturing in progress, on either date", () => {
    const sent = "2026-09-08T10:00:00Z";
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: sent, est_start: "2026-09-09" })))).toBe(
      "manufacturing",
    );
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: sent, est_finish: "2026-09-30" })))).toBe(
      "manufacturing",
    );
  });

  it("finished: Shipping, even with dates still on the row", () => {
    expect(
      deriveStage(
        po(
          "SRO_TO_SUPPLIER",
          "approved",
          null,
          mfg({ sent_at: "2026-09-08T10:00:00Z", est_start: "2026-09-09", finished_at: "2026-09-20T09:00:00Z" }),
        ),
      ),
    ).toBe("shipping");
  });
});

describe("effectiveStage, persisted stage wins, else derive", () => {
  it("a valid persisted stage overrides the derived one", () => {
    // A depot PO manually dragged into Manufacturing shows there.
    expect(effectiveStage(po("DEPOT_TO_EB_GROUP", "requested", "manufacturing"))).toBe("manufacturing");
    expect(effectiveStage(po("SRO_TO_SUPPLIER", "requested", "sent_manufacturing"))).toBe("sent_manufacturing");
  });
  it("null lifecycle_stage falls back to derive", () => {
    expect(effectiveStage(po("EB_GROUP_TO_SRO", "approved", null))).toBe("sro");
    expect(effectiveStage(po("EB_GROUP_TO_SRO", "requested", null))).toBe("group_sro");
  });
  it("an unknown persisted value is ignored (falls back to derive)", () => {
    expect(effectiveStage(po("SRO_TO_SUPPLIER", "approved", "bogus" as never))).toBe("sro");
  });
});

describe("isLifecycleStage", () => {
  it("accepts only known keys", () => {
    expect(isLifecycleStage("manufacturing")).toBe(true);
    expect(isLifecycleStage("bogus")).toBe(false);
    expect(isLifecycleStage(null)).toBe(false);
    expect(isLifecycleStage(undefined)).toBe(false);
  });
});
