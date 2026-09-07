/**
 * Container fill — greedy allocation of a container's CBM budget across the
 * SKUs the buffer engine says need replenishing (Task 15).
 *
 * PURE — no IO, no dates, no randomness. Callers hand in candidates already
 * filtered to red/yellow (green is accepted defensively but always dropped —
 * a green SKU has no need by definition).
 *
 * Greedy order: reds first (by gap desc), then yellows (by gap desc); within
 * a band ties break on sku ascending so results are stable and deterministic
 * for identical input regardless of array order. Reds always get first shot
 * at capacity — no yellow is placed while any red still has room to grow.
 *
 * Need = ceil(greenTop − nfp), floored (not rounded) at moq when moq > 0. If
 * the full need does not fit the remaining CBM budget, the qty is TRIMMED to
 * floor(remaining / cbmPerUnit); a trim that would fall below moq (or below
 * 1 unit with no moq) is not placed at all — it drops with "does_not_fit" and
 * the next candidate is still tried against the unchanged remaining budget.
 */

export interface ContainerCandidate {
  sku: string;
  zone: "red" | "yellow" | "green";
  nfp: number;
  greenTop: number;
  moq: number; // 0 = none
  cbmPerUnit: number | null; // null = cannot be placed, must be reported
}

export interface ContainerFill {
  lines: { sku: string; qty: number; cbm: number }[];
  cbmUsed: number;
  cbmCapacity: number;
  dropped: { sku: string; reason: "no_cbm" | "does_not_fit" | "no_need" }[];
}

/** 40ft high-cube container, usable CBM (Dave's figure). */
export const DEFAULT_CONTAINER_CBM = 66;

/** Stable sort by (greenTop − nfp) desc, tie-break sku asc. */
function byGapDescThenSku(a: ContainerCandidate, b: ContainerCandidate): number {
  const gapA = a.greenTop - a.nfp;
  const gapB = b.greenTop - b.nfp;
  if (gapA !== gapB) return gapB - gapA;
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

export function fillContainer(
  cands: ContainerCandidate[],
  cbmCapacity: number = DEFAULT_CONTAINER_CBM
): ContainerFill {
  const reds = cands.filter((c) => c.zone === "red").sort(byGapDescThenSku);
  const yellows = cands.filter((c) => c.zone === "yellow").sort(byGapDescThenSku);
  // Callers shouldn't pass green candidates (no need by definition); handled
  // defensively below rather than silently ignored, so a caller mistake shows
  // up in `dropped` instead of vanishing.
  const others = cands.filter((c) => c.zone !== "red" && c.zone !== "yellow");

  const lines: ContainerFill["lines"] = [];
  const dropped: ContainerFill["dropped"] = [];
  let cbmUsed = 0;

  for (const c of [...reds, ...yellows, ...others]) {
    if (c.zone === "green") {
      dropped.push({ sku: c.sku, reason: "no_need" });
      continue;
    }

    const rawGap = c.greenTop - c.nfp;
    if (rawGap <= 0) {
      // Defensive: a red/yellow row should never reach here under DDMRP math
      // (greenTop always exceeds nfp while in either zone), but a malformed
      // candidate must not silently vanish or fabricate an order.
      dropped.push({ sku: c.sku, reason: "no_need" });
      continue;
    }

    let need = Math.ceil(rawGap);
    if (c.moq > 0) need = Math.max(need, c.moq); // MOQ is a floor, not a rounding step.

    if (c.cbmPerUnit === null) {
      dropped.push({ sku: c.sku, reason: "no_cbm" });
      continue;
    }

    const remaining = cbmCapacity - cbmUsed;
    const fullCbm = need * c.cbmPerUnit;
    if (fullCbm <= remaining) {
      lines.push({ sku: c.sku, qty: need, cbm: fullCbm });
      cbmUsed += fullCbm;
      continue;
    }

    const trimmedQty = Math.floor(remaining / c.cbmPerUnit);
    const floor = c.moq > 0 ? c.moq : 1;
    if (trimmedQty < floor || trimmedQty < 1) {
      dropped.push({ sku: c.sku, reason: "does_not_fit" });
      continue;
    }

    const trimmedCbm = trimmedQty * c.cbmPerUnit;
    lines.push({ sku: c.sku, qty: trimmedQty, cbm: trimmedCbm });
    cbmUsed += trimmedCbm;
  }

  return { lines, cbmUsed, cbmCapacity, dropped };
}
