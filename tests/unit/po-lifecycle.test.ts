import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_KEYS,
  deriveStage,
  effectiveStage,
  isLifecycleStage,
  stageLabel,
} from "@/lib/po-lifecycle";
import type { PurchaseOrder } from "@/lib/erp-types";

type Leg = PurchaseOrder["leg"];
type Status = PurchaseOrder["status"];
const po = (leg: Leg, status: Status, lifecycle_stage: PurchaseOrder["lifecycle_stage"] = null) =>
  ({ leg, status, lifecycle_stage }) as Pick<PurchaseOrder, "leg" | "status" | "lifecycle_stage">;

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

describe("deriveStage — leg places the intercompany columns", () => {
  it("depot leg → depot_group", () => {
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "requested"))).toBe("depot_group");
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "approved"))).toBe("depot_group");
  });
  it("group leg → group_sro", () => {
    expect(deriveStage(po("EB_GROUP_TO_SRO", "approved"))).toBe("group_sro");
  });
  it("SRO→Bamida leg lands 'at S.R.O' (dragged onward from there)", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "requested"))).toBe("sro");
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved"))).toBe("sro");
  });
  it("cargo leg → shipping (the transport arrangement)", () => {
    expect(deriveStage(po("SRO_TO_CARGO", "requested"))).toBe("shipping");
  });
});

describe("deriveStage — status wins for manufacturing/shipping", () => {
  it("in_manufacturing → manufacturing regardless of leg", () => {
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "in_manufacturing"))).toBe("manufacturing");
    expect(deriveStage(po("SRO_TO_SUPPLIER", "in_manufacturing"))).toBe("manufacturing");
  });
  it("shipped / delivered → shipping regardless of leg", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "shipped"))).toBe("shipping");
    expect(deriveStage(po("DEPOT_TO_EB_GROUP", "delivered"))).toBe("shipping");
  });
});

describe("effectiveStage — persisted stage wins, else derive", () => {
  it("a valid persisted stage overrides the derived one", () => {
    // A depot PO manually dragged into Manufacturing shows there.
    expect(effectiveStage(po("DEPOT_TO_EB_GROUP", "requested", "manufacturing"))).toBe("manufacturing");
    expect(effectiveStage(po("SRO_TO_SUPPLIER", "requested", "sent_manufacturing"))).toBe("sent_manufacturing");
  });
  it("null lifecycle_stage falls back to derive", () => {
    expect(effectiveStage(po("EB_GROUP_TO_SRO", "approved", null))).toBe("group_sro");
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
