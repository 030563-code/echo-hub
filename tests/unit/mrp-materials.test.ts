import { describe, expect, it } from "vitest";
import {
  materialsCeiling,
  requiredFor,
  shortagesFor,
  type BomComponentRow,
  type BomProductRow,
} from "@/lib/mrp/materials";

const product = (palletSize: number | null): BomProductRow => ({
  fg_code: "FG",
  pallet_size: palletSize,
});

const comp = (
  component_code: string,
  qty: number,
  basis: "per_unit" | "per_pallet",
  is_gating = true
): BomComponentRow => ({
  fg_code: "FG",
  component_code,
  component_desc: `desc ${component_code}`,
  qty,
  basis,
  line_type: "material",
  is_gating,
});

const stock = (pairs: Array<[string, number]>) => new Map(pairs);

describe("requiredFor — the two-tier step function", () => {
  it("scales per_unit components linearly", () => {
    const req = requiredFor([comp("A", 2.85, "per_unit")], 70, 100);
    expect(req.get("A")).toBeCloseTo(285, 6);
  });

  it("scales per_pallet components by WHOLE pallets, not by units", () => {
    // 70 units = exactly 1 pallet
    expect(requiredFor([comp("B", 16, "per_pallet")], 70, 70).get("B")).toBe(16);
    // 71 units spills into a second pallet and consumes a second set
    expect(requiredFor([comp("B", 16, "per_pallet")], 70, 71).get("B")).toBe(32);
  });

  it("charges a full pallet for a single unit", () => {
    expect(requiredFor([comp("B", 16, "per_pallet")], 70, 1).get("B")).toBe(16);
  });

  it("requires nothing at zero quantity", () => {
    const req = requiredFor([comp("A", 2.85, "per_unit"), comp("B", 16, "per_pallet")], 70, 0);
    expect(req.get("A")).toBe(0);
    expect(req.get("B")).toBe(0);
  });

  it("sums both bases when one component is consumed in both roles", () => {
    // HT 3,5 uses black thread 3097 as main thread (20 m/unit) AND bag thread
    // (50 m/pallet), printed as two separate lines against one stock pool.
    const rows = [comp("3097", 20, "per_unit"), comp("3097", 50, "per_pallet")];
    // 30 units = 1 pallet: 30*20 + 1*50
    expect(requiredFor(rows, 30, 30).get("3097")).toBe(650);
    // 31 units = 2 pallets: 31*20 + 2*50
    expect(requiredFor(rows, 30, 31).get("3097")).toBe(720);
  });

  it("ignores per_pallet rows when pallet size is unknown", () => {
    const req = requiredFor([comp("A", 2, "per_unit"), comp("B", 16, "per_pallet")], null, 10);
    expect(req.get("A")).toBe(20);
    expect(req.has("B")).toBe(false);
  });
});

describe("materialsCeiling", () => {
  it("bounds on a per_unit component and names what binds", () => {
    const r = materialsCeiling(product(70), [comp("A", 10, "per_unit")], stock([["A", 105]]));
    expect(r.maxBuildable).toBe(10);
    expect(r.bindingComponent).toBe("A");
  });

  it("bounds on a per_pallet component in whole pallets", () => {
    // 4 bags at 1 per pallet, 70 units per pallet -> 280 units, not 4
    const r = materialsCeiling(product(70), [comp("BAG", 1, "per_pallet")], stock([["BAG", 4]]));
    expect(r.maxBuildable).toBe(280);
    expect(r.bindingComponent).toBe("BAG");
  });

  it("does not let a per_pallet bound overshoot into an unaffordable pallet", () => {
    // 1 pallet's worth of screws. 70 is affordable; 71 would need a 2nd set.
    const r = materialsCeiling(product(70), [comp("SCR", 16, "per_pallet")], stock([["SCR", 16]]));
    expect(r.maxBuildable).toBe(70);
    expect(requiredFor([comp("SCR", 16, "per_pallet")], 70, 71).get("SCR")).toBeGreaterThan(16);
  });

  it("takes the minimum across components and reports the true binding one", () => {
    const r = materialsCeiling(
      product(70),
      [comp("PLENTY", 1, "per_unit"), comp("SCARCE", 1, "per_unit")],
      stock([
        ["PLENTY", 10_000],
        ["SCARCE", 42],
      ])
    );
    expect(r.maxBuildable).toBe(42);
    expect(r.bindingComponent).toBe("SCARCE");
  });

  it("clamps negative stock to zero rather than producing a negative ceiling", () => {
    // Bamida's available_quantity runs deeply negative; physical quantity should
    // never do this, but the engine must not emit a negative buildable if it does.
    const r = materialsCeiling(product(70), [comp("A", 39, "per_unit")], stock([["A", -165_717]]));
    expect(r.maxBuildable).toBe(0);
  });

  it("excludes non-gating components from the bound", () => {
    const r = materialsCeiling(
      product(70),
      [comp("A", 1, "per_unit"), comp("INVISIBLE", 1000, "per_unit", false)],
      stock([["A", 50]])
    );
    expect(r.maxBuildable).toBe(50);
  });

  it("reports a gating component with no stock row and excludes it from the bound", () => {
    const r = materialsCeiling(
      product(70),
      [comp("A", 1, "per_unit"), comp("GHOST", 1, "per_unit")],
      stock([["A", 50]])
    );
    expect(r.unjoined).toEqual(["GHOST"]);
    expect(r.maxBuildable).toBe(50);
  });

  it("returns null when no gating component can be evaluated", () => {
    const r = materialsCeiling(product(70), [comp("GHOST", 1, "per_unit")], stock([]));
    expect(r.maxBuildable).toBeNull();
  });

  it("returns null when the product has no gating components at all", () => {
    const r = materialsCeiling(product(70), [comp("X", 1, "per_unit", false)], stock([["X", 5]]));
    expect(r.maxBuildable).toBeNull();
  });

  it("flags per_pallet rows it had to ignore because pallet size is unknown", () => {
    const r = materialsCeiling(
      product(null),
      [comp("A", 1, "per_unit"), comp("BAG", 1, "per_pallet")],
      stock([
        ["A", 50],
        ["BAG", 1],
      ])
    );
    expect(r.maxBuildable).toBe(50);
    expect(r.palletSizeUnknown).toBe(true);
  });

  it("whatever it returns is actually buildable, and one more is not", () => {
    // The property that matters: the answer is the exact frontier.
    const rows = [
      comp("FABRIC", 2.85, "per_unit"),
      comp("EYELET", 19, "per_unit"),
      comp("SCREW", 16, "per_pallet"),
      comp("BAG", 1, "per_pallet"),
    ];
    const s = stock([
      ["FABRIC", 24_586],
      ["EYELET", 107_484],
      ["SCREW", 500],
      ["BAG", 9],
    ]);
    const r = materialsCeiling(product(70), rows, s);
    const q = r.maxBuildable!;
    const fits = (n: number) =>
      [...requiredFor(rows, 70, n).entries()].every(([c, need]) => need <= (s.get(c) ?? 0));
    expect(fits(q)).toBe(true);
    expect(fits(q + 1)).toBe(false);
  });

  it("reproduces the live H9 ceiling from the delivery-note BOM", () => {
    // Gating rows for FG 000716 against bamida_material_stock physical quantity
    // as at the 2026-08-08 sync. Kovove istenie (4 on hand, 1 per pallet)
    // binds at 4 pallets x 70 = 280.
    const rows = [
      comp("5097", 2.85, "per_unit"),
      comp("606", 7, "per_unit"),
      comp("7", 19, "per_unit"),
      comp("2204", 1.71, "per_unit"),
      comp("3076", 5, "per_unit"),
      comp("2189", 39, "per_unit"),
      comp("4898", 20, "per_pallet"),
      comp("2192", 50, "per_pallet"),
      comp("1781", 1, "per_pallet"),
      comp("361", 6, "per_pallet"),
    ];
    const r = materialsCeiling(
      product(70),
      rows,
      stock([
        ["5097", 24_586.08],
        ["606", 40_451.6],
        ["7", 107_484],
        ["2204", 7_179.6],
        ["3076", 26_152.5],
        ["2189", 75_093],
        ["4898", 3_000],
        ["2192", 5_000],
        ["1781", 4],
        ["361", 5_000],
      ])
    );
    expect(r.maxBuildable).toBe(280);
    expect(r.bindingComponent).toBe("1781");
  });
});

describe('bomEstimated — an estimate must not read as an engineering BOM', () => {
  const est = (code: string, qty: number): BomComponentRow => ({
    ...comp(code, qty, 'per_unit'),
    source_kind: 'delivery_note_estimate',
  })
  const official = (code: string, qty: number): BomComponentRow => ({
    ...comp(code, qty, 'per_unit'),
    source_kind: 'official_bom',
  })

  it('flags a ceiling resting on delivery-note estimates', () => {
    const r = materialsCeiling(product(70), [est('A', 2)], stock([['A', 100]]))
    expect(r.maxBuildable).toBe(50)
    expect(r.bomEstimated).toBe(true)
  })

  it('does not flag a ceiling resting only on an official BOM', () => {
    const r = materialsCeiling(product(70), [official('A', 2)], stock([['A', 100]]))
    expect(r.bomEstimated).toBe(false)
  })

  it('treats a missing source_kind as an estimate, not as official', () => {
    // Defaulting the other way would let an un-migrated row silently claim
    // authority it never had.
    const r = materialsCeiling(product(70), [comp('A', 2, 'per_unit')], stock([['A', 100]]))
    expect(r.bomEstimated).toBe(true)
  })

  it('flags when the mix is partly estimated', () => {
    const r = materialsCeiling(
      product(70),
      [official('A', 1), est('B', 1)],
      stock([['A', 100], ['B', 100]])
    )
    expect(r.bomEstimated).toBe(true)
  })

  it('still flags when stock is exhausted', () => {
    const r = materialsCeiling(product(70), [est('A', 5)], stock([['A', 0]]))
    expect(r.maxBuildable).toBe(0)
    expect(r.bomEstimated).toBe(true)
  })
})

describe("shortagesFor — can they build THIS order", () => {
  it("reports nothing when the materials are there", () => {
    const out = shortagesFor(product(70), [comp("A", 2, "per_unit")], stock([["A", 500]]), 100);
    expect(out.shortages).toEqual([]);
    expect(out.unjoined).toEqual([]);
    expect(out.palletSizeUnknown).toBe(false);
  });

  it("names what is short, by how much, worst first", () => {
    const out = shortagesFor(
      product(70),
      [comp("A", 2, "per_unit"), comp("B", 10, "per_unit")],
      stock([
        ["A", 150],
        ["B", 900],
      ]),
      100
    );
    expect(out.shortages).toEqual([
      { code: "B", description: "desc B", need: 1000, have: 900, short: 100 },
      { code: "A", description: "desc A", need: 200, have: 150, short: 50 },
    ]);
  });

  it("charges a per_pallet row by WHOLE pallets, so one unit over the boundary is short", () => {
    // 4 sets of consumables on the shelf. 280 units is exactly 4 pallets and fits;
    // 281 spills into a fifth and does not. This is the live H9 constraint.
    const bom = [comp("1781", 1, "per_pallet")];
    expect(shortagesFor(product(70), bom, stock([["1781", 4]]), 280).shortages).toEqual([]);
    expect(shortagesFor(product(70), bom, stock([["1781", 4]]), 281).shortages).toEqual([
      { code: "1781", description: "desc 1781", need: 5, have: 4, short: 1 },
    ]);
  });

  it("agrees with the ceiling: the largest build with no shortage is maxBuildable", () => {
    const bom = [comp("1781", 1, "per_pallet"), comp("2189", 39, "per_unit")];
    const shelf = stock([
      ["1781", 4],
      ["2189", 75093],
    ]);
    const ceiling = materialsCeiling(product(70), bom, shelf).maxBuildable
    expect(ceiling).toBe(280);
    expect(shortagesFor(product(70), bom, shelf, ceiling!).shortages).toEqual([]);
    expect(shortagesFor(product(70), bom, shelf, ceiling! + 1).shortages.length).toBeGreaterThan(0);
  });

  it("reports a component with no stock card as unknown, never as a shortage", () => {
    const out = shortagesFor(product(70), [comp("GHOST", 5, "per_unit")], stock([]), 100);
    expect(out.shortages).toEqual([]);
    expect(out.unjoined).toEqual(["GHOST"]);
  });

  it("ignores non-gating rows, which are absent from the live feed by design", () => {
    const out = shortagesFor(
      product(70),
      [comp("A", 1000, "per_unit", false)],
      stock([["A", 1]]),
      100
    );
    expect(out.shortages).toEqual([]);
  });

  it("says so rather than guessing when a per_pallet row has no pallet size", () => {
    const out = shortagesFor(product(null), [comp("A", 16, "per_pallet")], stock([["A", 1]]), 100);
    expect(out.shortages).toEqual([]);
    expect(out.palletSizeUnknown).toBe(true);
  });

  it("treats a negative stock reading as zero rather than as a credit", () => {
    const out = shortagesFor(product(70), [comp("A", 1, "per_unit")], stock([["A", -165717]]), 10);
    expect(out.shortages).toEqual([
      { code: "A", description: "desc A", need: 10, have: 0, short: 10 },
    ]);
  });

  it("asks for nothing when nothing is ordered", () => {
    expect(shortagesFor(product(70), [comp("A", 1, "per_unit")], stock([["A", 0]]), 0).shortages).toEqual([]);
  });
})
