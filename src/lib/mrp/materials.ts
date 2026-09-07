/**
 * Materials ceiling — how many units of a finished good Bamida could build
 * right now, given the manufacturing BOM and live material stock.
 *
 * Two things here are easy to get wrong and are the whole reason this is its
 * own module with its own tests.
 *
 * 1. CONSUMPTION IS A STEP FUNCTION, NOT A LINE. Materials scale either per
 *    finished unit or per PALLET (70 units for the 1335 mm panels, 30 for the
 *    3650 mm ones). Packing bags, screws, washers, kasir and bag thread are all
 *    charged by whole pallets, so 71 units of a 70/pallet product costs two full
 *    sets of consumables. The naive `floor(stock / qty_per)` used before this
 *    module cannot express that, and it silently over-reports near a pallet
 *    boundary.
 *
 * 2. STOCK MUST BE READ FROM PHYSICAL `quantity`, NOT `available_quantity`.
 *    Bamida's available_quantity is quantity minus reservations that are never
 *    drained, so on fast-moving materials it is deeply negative — orange thread
 *    reads -165,717 m against 75,093 m actually on the shelf. Feeding that in
 *    makes every product permanently unbuildable. The caller passes physical
 *    quantity; this module clamps at zero purely as a backstop.
 *
 * Because requirement is monotonic in quantity, the ceiling is found by
 * doubling to bracket the frontier and then bisecting it, rather than by
 * dividing each component independently — division cannot see the interaction
 * between a per-unit and a per-pallet draw on the same stock pool (HT 3,5 uses
 * black thread 3097 in both roles).
 */

export interface BomProductRow {
  fg_code: string;
  pallet_size: number | null;
}

export interface BomComponentRow {
  fg_code: string;
  component_code: string;
  component_desc: string;
  qty: number;
  basis: "per_unit" | "per_pallet";
  line_type: "material" | "operation" | "intermediate";
  is_gating: boolean;
  /** 'delivery_note_estimate' until an engineering BOM replaces it. */
  source_kind?: string;
}

export interface MaterialsCeiling {
  /** Units buildable now. Null when nothing gating could be evaluated. */
  maxBuildable: number | null;
  /** The component that actually binds the ceiling — what to go and buy. */
  bindingComponent: string | null;
  bindingDesc: string | null;
  /** Gating components with no matching stock card; excluded, never silent. */
  unjoined: string[];
  /** True when per_pallet rows had to be skipped for want of a pallet size. */
  palletSizeUnknown: boolean;
  /**
   * True when any component the ceiling actually rests on is an estimate
   * rather than an engineering BOM. Independent of whether the SKU mapping is
   * confirmed — the two get resolved at different times, and once the mapping
   * is confirmed the ceiling would otherwise start looking authoritative while
   * still resting on one observed batch.
   */
  bomEstimated: boolean;
}

/** Per-component demand, keyed on component_code, for a build of `qty` units. */
export function requiredFor(
  components: BomComponentRow[],
  palletSize: number | null,
  qty: number
): Map<string, number> {
  const pallets = palletSize && palletSize > 0 ? Math.ceil(qty / palletSize) : 0;
  const out = new Map<string, number>();
  for (const c of components) {
    // A pallet-based row is unusable without a pallet size. Skipping is the
    // honest failure: guessing a size would fabricate a constraint, and
    // treating it as per-unit would overstate demand ~30-70x.
    if (c.basis === "per_pallet" && !(palletSize && palletSize > 0)) continue;
    const need = c.basis === "per_unit" ? c.qty * qty : c.qty * pallets;
    out.set(c.component_code, (out.get(c.component_code) ?? 0) + need);
  }
  return out;
}

export function materialsCeiling(
  product: BomProductRow,
  components: BomComponentRow[],
  stockByCode: Map<string, number>
): MaterialsCeiling {
  const palletSize = product.pallet_size && product.pallet_size > 0 ? product.pallet_size : null;
  const gating = components.filter((c) => c.is_gating);

  const unjoined: string[] = [];
  const usable: BomComponentRow[] = [];
  const seenUnjoined = new Set<string>();
  let skippedPalletRow = false;

  for (const c of gating) {
    if (c.basis === "per_pallet" && palletSize === null) {
      skippedPalletRow = true;
      continue;
    }
    if (!stockByCode.has(c.component_code)) {
      if (!seenUnjoined.has(c.component_code)) {
        seenUnjoined.add(c.component_code);
        unjoined.push(c.component_code);
      }
      continue;
    }
    if (c.qty > 0) usable.push(c);
  }

  const base: MaterialsCeiling = {
    maxBuildable: null,
    bindingComponent: null,
    bindingDesc: null,
    unjoined,
    palletSizeUnknown: skippedPalletRow,
    bomEstimated: false,
  };

  // Only the components the bound actually rests on matter here; a stray
  // estimated row that never binds should not taint a ceiling.
  const bomEstimated = usable.some((c) => (c.source_kind ?? "delivery_note_estimate") !== "official_bom");
  if (usable.length === 0) return base;

  const available = (code: string) => Math.max(stockByCode.get(code) ?? 0, 0);

  const fits = (n: number): boolean => {
    for (const [code, need] of requiredFor(usable, palletSize, n)) {
      if (need > available(code)) return false;
    }
    return true;
  };

  if (!fits(0)) return { ...base, maxBuildable: 0, bomEstimated };

  // Bracket the frontier by doubling. Requirement is non-decreasing in n, so
  // the first infeasible power of two is a valid upper bound. The cap keeps a
  // BOM whose gating rows are all zero-qty from running away; usable already
  // excludes qty<=0, so in practice this is never reached.
  const CAP = 1 << 30;
  let lo = 0;
  let hi = 1;
  while (hi < CAP && fits(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi >= CAP && fits(CAP)) return base; // unbounded — treat as unknown

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }

  // Name what binds: the component that would be exceeded first by building one
  // more. That is the actionable output — "buy this" — not the bare number.
  let bindingComponent: string | null = null;
  let bindingDesc: string | null = null;
  let worstOverrun = 0;
  for (const [code, need] of requiredFor(usable, palletSize, lo + 1)) {
    const overrun = need - available(code);
    if (overrun > worstOverrun) {
      worstOverrun = overrun;
      bindingComponent = code;
      bindingDesc = usable.find((c) => c.component_code === code)?.component_desc ?? null;
    }
  }

  return { ...base, maxBuildable: lo, bindingComponent, bindingDesc, bomEstimated };
}
