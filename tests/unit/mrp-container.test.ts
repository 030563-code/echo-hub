import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER_CBM, fillContainer, type ContainerCandidate } from "@/lib/mrp/container";

const cand = (over: Partial<ContainerCandidate> & { sku: string }): ContainerCandidate => ({
  zone: "red",
  nfp: 0,
  greenTop: 100,
  moq: 0,
  cbmPerUnit: 1,
  ...over,
});

describe("fillContainer", () => {
  it("places reds before yellows regardless of input order", () => {
    const fill = fillContainer([
      cand({ sku: "YEL", zone: "yellow", greenTop: 50, cbmPerUnit: 1 }),
      cand({ sku: "RED", zone: "red", greenTop: 50, cbmPerUnit: 1 }),
    ]);
    expect(fill.lines.map((l) => l.sku)).toEqual(["RED", "YEL"]);
  });

  it("orders within a band by (greenTop - nfp) desc, tie-break sku asc", () => {
    const fill = fillContainer([
      cand({ sku: "R2", zone: "red", nfp: 10, greenTop: 30 }), // gap 20
      cand({ sku: "R1", zone: "red", nfp: 10, greenTop: 40 }), // gap 30
      cand({ sku: "R3", zone: "red", nfp: 10, greenTop: 40 }), // gap 30 (tie with R1)
    ]);
    expect(fill.lines.map((l) => l.sku)).toEqual(["R1", "R3", "R2"]);
  });

  it("floors need at moq without rounding to a multiple of it", () => {
    const fill = fillContainer([cand({ sku: "A", nfp: 90, greenTop: 100, moq: 50, cbmPerUnit: 1 })]);
    // raw need = ceil(10) = 10, floored up to moq 50 (not rounded to a 50-multiple).
    expect(fill.lines).toEqual([{ sku: "A", qty: 50, cbm: 50 }]);
  });

  it("trims qty to fit remaining capacity, never below 1 or moq", () => {
    const fill = fillContainer([cand({ sku: "A", nfp: 0, greenTop: 100, cbmPerUnit: 2 })], 15);
    // need 100, at 2 cbm/unit needs 200 cbm; only 15 available → floor(15/2) = 7
    expect(fill.lines).toEqual([{ sku: "A", qty: 7, cbm: 14 }]);
    expect(fill.cbmUsed).toBe(14);
  });

  it("drops a red that cannot fit at all, and the next red still fills from the untouched budget", () => {
    const fill = fillContainer(
      [
        cand({ sku: "BIG", zone: "red", nfp: 0, greenTop: 10, cbmPerUnit: 100 }), // needs 1000 cbm, capacity 10 → floor(10/100)=0
        cand({ sku: "SMALL", zone: "red", nfp: 90, greenTop: 100, cbmPerUnit: 1 }), // needs 10 cbm — fits fully
      ],
      10
    );
    expect(fill.dropped).toEqual([{ sku: "BIG", reason: "does_not_fit" }]);
    expect(fill.lines).toEqual([{ sku: "SMALL", qty: 10, cbm: 10 }]);
  });

  it("drops a red whose trimmed qty would fall below its moq", () => {
    const fill = fillContainer([cand({ sku: "A", nfp: 0, greenTop: 100, moq: 20, cbmPerUnit: 1 })], 5);
    // need floored to moq 20; only 5 cbm available → floor(5/1)=5 < moq 20 → does_not_fit
    expect(fill.dropped).toEqual([{ sku: "A", reason: "does_not_fit" }]);
    expect(fill.lines).toEqual([]);
  });

  it("drops null-cbm candidates without guessing", () => {
    const fill = fillContainer([cand({ sku: "A", cbmPerUnit: null })]);
    expect(fill.dropped).toEqual([{ sku: "A", reason: "no_cbm" }]);
    expect(fill.lines).toEqual([]);
  });

  it("drops green candidates defensively as no_need", () => {
    const fill = fillContainer([cand({ sku: "A", zone: "green", nfp: 0, greenTop: 100 })]);
    expect(fill.dropped).toEqual([{ sku: "A", reason: "no_need" }]);
  });

  it("consumes capacity exactly at the edge without trimming", () => {
    const fill = fillContainer([cand({ sku: "A", nfp: 0, greenTop: 10, cbmPerUnit: 2 })], 20);
    expect(fill.lines).toEqual([{ sku: "A", qty: 10, cbm: 20 }]);
    expect(fill.cbmUsed).toBe(20);
  });

  it("is deterministic: identical input in a different array order yields identical output", () => {
    const a = [
      cand({ sku: "R1", zone: "red", nfp: 10, greenTop: 40 }),
      cand({ sku: "Y1", zone: "yellow", nfp: 20, greenTop: 60 }),
      cand({ sku: "R2", zone: "red", nfp: 5, greenTop: 45 }),
    ];
    const b = [a[2], a[0], a[1]];
    expect(fillContainer(a)).toEqual(fillContainer(b));
  });

  it("returns an empty fill for empty input, using the default CBM capacity", () => {
    const fill = fillContainer([]);
    expect(fill).toEqual({ lines: [], cbmUsed: 0, cbmCapacity: DEFAULT_CONTAINER_CBM, dropped: [] });
  });
});
