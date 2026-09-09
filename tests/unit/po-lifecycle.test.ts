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
type Input = Pick<PurchaseOrder, "leg" | "status" | "lifecycle_stage" | "manufacturing"> & {
  shipment?: PurchaseOrder["shipment"];
};

const po = (
  leg: Leg,
  status: Status,
  lifecycle_stage: PurchaseOrder["lifecycle_stage"] = null,
  manufacturing: PoManufacturing | null = null,
  shipment: PurchaseOrder["shipment"] = null,
): Input => ({ leg, status, lifecycle_stage, manufacturing, shipment });

/** A po_shipments row. Only spot_id decides anything here. */
const booked = (spot_id: string | null) =>
  ({ po_id: "x", po_number: null, spot_id, container_ref: null, eta: null, shipped_at: null,
     vessel: null, carrier: null, last_event: null, last_event_at: null, match_count: 1,
     resolved_at: "2026-09-09T00:00:00Z" }) as unknown as PurchaseOrder["shipment"];

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
  it("is the 7-column demo scheme in leg order", () => {
    // Ready for shipment sits between the two it separates: the goods exist,
    // and nobody has booked freight for them yet.
    expect(LIFECYCLE_STAGE_KEYS).toEqual([
      "depot_group",
      "group_sro",
      "sro",
      "sent_manufacturing",
      "manufacturing",
      "ready_for_shipment",
      "shipping",
    ]);
    expect(LIFECYCLE_STAGES.map((s) => s.label)).toEqual([
      "Depot → Group",
      "Group → S.R.O",
      "S.R.O",
      "Sent to manufacturing",
      "Manufacturing in progress",
      "Ready for shipment",
      "Shipping",
    ]);
  });

  it("stageLabel resolves each key", () => {
    expect(stageLabel("sent_manufacturing")).toBe("Sent to manufacturing");
    expect(stageLabel("ready_for_shipment")).toBe("Ready for shipment");
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
      deriveStage(
        po("SRO_TO_SUPPLIER", "approved", null, mfg({ est_start: "2026-09-09", est_finish: "2026-09-30" })),
        "2026-09-30",
      ),
    ).toBe("sro");
  });

  it("sent to Bamida: Sent to manufacturing", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: "2026-09-08T10:00:00Z" })))).toBe(
      "sent_manufacturing",
    );
  });

  it("dated but not started yet: still Sent to manufacturing", () => {
    const sent = "2026-09-08T10:00:00Z";
    const dated = po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: sent, est_start: "2026-09-20" }));
    expect(deriveStage(dated, "2026-09-09")).toBe("sent_manufacturing");
    expect(deriveStage(dated, "2026-09-19")).toBe("sent_manufacturing");
  });

  it("the estimated start date arrives: Manufacturing in progress, with no write", () => {
    const sent = "2026-09-08T10:00:00Z";
    const dated = po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: sent, est_start: "2026-09-20" }));
    expect(deriveStage(dated, "2026-09-20")).toBe("manufacturing");
    expect(deriveStage(dated, "2026-10-01")).toBe("manufacturing");
  });

  it("a finish date on its own moves nothing: it does not say work has started", () => {
    const sent = "2026-09-08T10:00:00Z";
    expect(
      deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: sent, est_finish: "2026-09-30" })), "2026-10-05"),
    ).toBe("sent_manufacturing");
  });

  it("today defaults to the real date, so the board needs no clock passed in", () => {
    const today = new Date().toISOString().slice(0, 10);
    const sent = "2026-09-08T10:00:00Z";
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: sent, est_start: today })))).toBe(
      "manufacturing",
    );
  });

  it("finished: Ready for shipment, not Shipping. Made is not booked", () => {
    // Dean, 9 Sep: finished barriers on a pallet in Presov are not in transit.
    expect(
      deriveStage(
        po(
          "SRO_TO_SUPPLIER",
          "approved",
          null,
          mfg({ sent_at: "2026-09-08T10:00:00Z", est_start: "2026-09-09", finished_at: "2026-09-20T09:00:00Z" }),
        ),
      ),
    ).toBe("ready_for_shipment");
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

describe("Ready for shipment: made is not booked", () => {
  const SENT = "2026-09-08T10:00:00Z";
  const FINISHED = mfg({ sent_at: SENT, est_start: "2026-09-09", finished_at: "2026-09-20T09:00:00Z" });

  it("an SRO order fulfilled from stock travels itself, because no Bamida order can", () => {
    // The ONE exception to "the SRO order stays at S.R.O": on the stock branch
    // there is no child order to carry the goods onward.
    expect(deriveStage(po("EB_GROUP_TO_SRO", "ready_for_shipment"))).toBe("ready_for_shipment");
  });

  it("still keeps a manufacturing SRO order at S.R.O, where its Bamida order carries it", () => {
    expect(deriveStage(po("EB_GROUP_TO_SRO", "in_manufacturing"))).toBe("sro");
    expect(deriveStage(po("EB_GROUP_TO_SRO", "fulfilling_from_stock"))).toBe("sro");
  });

  it("a confirmed SPOT id is what makes it Shipping, and it beats every leg rule", () => {
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, FINISHED, booked("SPOT-9931")))).toBe("shipping");
    expect(deriveStage(po("EB_GROUP_TO_SRO", "ready_for_shipment", null, null, booked("SPOT-9931")))).toBe("shipping");
    // Mid-manufacture with freight already booked is odd, but booked is booked.
    expect(
      deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ sent_at: SENT, est_start: "2026-09-01" }), booked("SPOT-1"))),
    ).toBe("shipping");
  });

  it("a shipment row with no SPOT id is not a booking", () => {
    // po_shipments gets a row from a lookup that found nothing, so the row
    // existing must not be mistaken for a confirmed booking.
    expect(deriveStage(po("SRO_TO_SUPPLIER", "approved", null, FINISHED, booked(null)))).toBe("ready_for_shipment");
    expect(deriveStage(po("EB_GROUP_TO_SRO", "ready_for_shipment", null, null, booked(null)))).toBe("ready_for_shipment");
  });

  it("accepts the new stage as a persisted value, so a drag to that column sticks", () => {
    expect(isLifecycleStage("ready_for_shipment")).toBe(true);
    expect(effectiveStage(po("SRO_TO_SUPPLIER", "approved", "ready_for_shipment"))).toBe("ready_for_shipment");
  });

  it("shipped and delivered still mean Shipping, whatever else is true", () => {
    expect(deriveStage(po("EB_GROUP_TO_SRO", "shipped"))).toBe("shipping");
    expect(deriveStage(po("SRO_TO_SUPPLIER", "delivered", null, FINISHED))).toBe("shipping");
  });
});

describe("finished outranks sent, because a stamp is not a typed date", () => {
  it("places a finished order at Ready for shipment even with no sent_at on the row", () => {
    // The finish action used to stamp lifecycle_stage, which outranks
    // derivation, so this ordering never showed. Removing that write exposed
    // it: finished_at is written by one one-shot button and nothing else.
    expect(
      deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ finished_at: "2026-09-20T09:00:00Z" }))),
    ).toBe("ready_for_shipment");
  });

  it("still ignores DATES on an order that was never sent", () => {
    expect(
      deriveStage(po("SRO_TO_SUPPLIER", "approved", null, mfg({ est_start: "2026-09-01", est_finish: "2026-09-30" })), "2026-10-05"),
    ).toBe("sro");
  });
});
