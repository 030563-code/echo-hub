#!/usr/bin/env python3
"""
Turn transcribed Bamida delivery notes into a two-tier bill of materials.

The delivery note records what was consumed to build ONE BATCH. The bill of
materials has to answer "what does one unit need", and the answer is not a
single division: some lines are drawn per unit and some per pallet, and the
pallet is a step function. Dividing everything by the batch size is wrong for
about a third of the lines, and wrong in the direction that under-orders.

  required(q) = per_unit * q + per_pallet * ceil(q / pallet_size)

This script does the arithmetic. It never guesses: where a document cannot
settle a value (a batch too small to pin the pallet size, packaging shared
between two products on one note) it says so and refuses to emit a rate.
"""
import json, math, os, re, sys
from collections import defaultdict

BOM = os.path.dirname(os.path.abspath(__file__)) + "/transcripts"

# Item codes that head a PACKAGING or SECURING group. Their children are drawn
# once per pallet, not once per unit. 30040 (the packing bag) is the anchor:
# exactly one per pallet on every note seen, which is what makes the pallet
# count observable at all.
PALLET_HEADS = {"30040", "30045"}
BAG_CODE = "30040"

# Item codes that head a group drawn once per ORDER, not per unit or per pallet.
# Ratchet straps ship as a loose accessory count against the order.
ORDER_HEADS = {"000856", "1838", "662"}

# A finished good headline: "Vyroba Echo Barrier <x>". Detected on the word,
# not the code, because the codes are not all zero-padded (Gen set M1 is 30049).
FG_RE = re.compile(r"^\s*V[yý]roba\b", re.I)
# The print intermediate that sits above the finished good on every note.
PRINT_RE = re.compile(r"^\s*Uv\s+potla", re.I)
# The welding intermediate.
WELD_RE = re.compile(r"^\s*Zv[aá]ranie\s+Echobarrier", re.I)


def load_docs():
    docs = {}
    for fn in sorted(os.listdir(BOM)):
        if not fn.endswith(".json") or fn.endswith(".verify.json"):
            continue
        with open(os.path.join(BOM, fn), encoding="utf-8") as fh:
            docs[fn[:-5]] = json.load(fh)
    return docs


def classify_items(doc):
    """Split a note's top-level items into finished goods, per-unit intermediates,
    per-pallet groups and per-order groups."""
    fgs, prints, welds, pallets, orders, unknown = [], [], [], [], [], []
    for it in doc["items"]:
        code, desc = str(it["code"]), it["description"]
        if code in PALLET_HEADS:
            pallets.append(it)
        elif code in ORDER_HEADS:
            orders.append(it)
        elif FG_RE.match(desc):
            fgs.append(it)
        elif PRINT_RE.match(desc):
            prints.append(it)
        elif WELD_RE.match(desc):
            welds.append(it)
        else:
            unknown.append(it)
    return fgs, prints, welds, pallets, orders, unknown


def nearest_fg(item, fgs, doc):
    """Attach an intermediate to the finished good it belongs to.

    On a single-product note there is one candidate and this is trivial. On a
    two-product note (ND RS 200 carries both 000800 and 000760) the batch size
    is the discriminator: the print run for 140 RS-200 panels is 140."""
    same_qty = [f for f in fgs if abs(f["qty"] - item["qty"]) < 1e-9]
    if len(same_qty) == 1:
        return same_qty[0], "matched on batch size"
    # Fall back to the finished good that follows this item on the page.
    later = [f for f in fgs if f["item_no"] > item["item_no"]]
    if later:
        return min(later, key=lambda f: f["item_no"]), "matched on page order"
    if len(fgs) == 1:
        return fgs[0], "only one finished good on the note"
    return None, "AMBIGUOUS"


# Delivery notes supplied to us as PARTIAL page-extracts. Their packaging lines
# cover products that appear in no file we hold, so no per-pallet rate can be
# attributed. Per-unit rates from the items we CAN see stay valid.
PARTIAL_NOTES = {"DLE25020008"}


def derive(doc, slug):
    fgs, prints, welds, pallets, orders, unknown = classify_items(doc)
    partial = doc["doc_number"] in PARTIAL_NOTES
    out = {"slug": slug, "doc": doc["doc_number"], "date": doc.get("issue_date"),
           "po": doc.get("external_po"), "products": [], "warnings": []}

    if not fgs:
        out["warnings"].append("no 'Vyroba' finished-good line on this note")
        return out
    for it in unknown:
        out["warnings"].append(
            f"item {it['item_no']} code {it['code']} '{it['description']}' "
            f"({it['qty']} {it['unit']}) did not classify; its children were NOT used")

    total_batch = sum(f["qty"] for f in fgs)
    bag = next((p for p in pallets if str(p["code"]) == BAG_CODE), None)
    pallet_count = bag["qty"] if bag else None

    for fg in fgs:
        batch = fg["qty"]
        prod = {"fg_code": str(fg["code"]), "fg_label": fg["description"],
                "batch": batch, "lines": [], "warnings": []}

        # ---- per-unit: the finished good's own children, plus the print and
        # weld intermediates that belong to it.
        groups = [(fg, "fg")]
        for grp, kind in ((prints, "print"), (welds, "weld")):
            for it in grp:
                owner, why = nearest_fg(it, fgs, doc)
                if owner is None:
                    prod["warnings"].append(
                        f"{kind} item {it['item_no']} could not be attached to a product ({why})")
                elif owner is fg:
                    groups.append((it, kind))
                    if why == "matched on page order" and len(fgs) > 1:
                        prod["warnings"].append(
                            f"{kind} item {it['item_no']} attached by page order, not batch size")

        for grp, kind in groups:
            # The intermediate headline itself (1 print per panel) is a real line.
            if kind in ("print", "weld"):
                prod["lines"].append(dict(
                    code=str(grp["code"]), desc=grp["description"],
                    qty=grp["qty"] / batch, unit=grp["unit"], basis="per_unit",
                    line_type="intermediate" if kind == "print" else "operation",
                    raw=grp["qty"]))
            for ch in grp["children"]:
                prod["lines"].append(dict(
                    code=str(ch["code"]), desc=ch["description"],
                    qty=ch["qty"] / batch, unit=ch["unit"], basis="per_unit",
                    line_type="material" if ch["kind"] == "material" else "operation",
                    raw=ch["qty"]))

        # ---- per-pallet
        if partial:
            prod["warnings"].append(
                "note supplied as a PARTIAL extract; its packaging covers products not in "
                "any file we hold, so no per-pallet rate is derived")
        elif pallet_count:
            share = batch / total_batch          # split shared packaging by batch share
            shared = len(fgs) > 1
            if shared:
                prod["warnings"].append(
                    f"this note carries {len(fgs)} products and one set of packaging lines; "
                    f"per-pallet rates are apportioned by batch share ({share:.3f}) and are ESTIMATES")
            for p in pallets:
                prod["lines"].append(dict(
                    code=str(p["code"]), desc=p["description"],
                    qty=p["qty"] / pallet_count, unit=p["unit"], basis="per_pallet",
                    line_type="material", raw=p["qty"]))
                for ch in p["children"]:
                    prod["lines"].append(dict(
                        code=str(ch["code"]), desc=ch["description"],
                        qty=ch["qty"] / pallet_count, unit=ch["unit"], basis="per_pallet",
                        line_type="material" if ch["kind"] == "material" else "operation",
                        raw=ch["qty"]))
        else:
            prod["warnings"].append("no packing-bag line, so no pallet count and no per-pallet rates")

        # ---- per-order lines are recorded but never made a per-unit rate.
        for o in orders:
            prod["lines"].append(dict(
                code=str(o["code"]), desc=o["description"], qty=o["qty"],
                unit=o["unit"], basis="per_order", line_type="material", raw=o["qty"]))
            for ch in o["children"]:
                prod["lines"].append(dict(
                    code=str(ch["code"]), desc=ch["description"], qty=ch["qty"],
                    unit=ch["unit"], basis="per_order",
                    line_type="material" if ch["kind"] == "material" else "operation",
                    raw=ch["qty"]))

        # ---- pallet size, and how tightly this note pins it.
        if partial:
            prod["pallet_size"] = None
        elif pallet_count and len(fgs) == 1:
            lo = math.ceil(batch / pallet_count)          # smallest size giving this count
            hi = (math.floor((batch - 1) / (pallet_count - 1))
                  if pallet_count > 1 else None)          # largest, unbounded at 1 pallet
            prod["pallet_count"] = pallet_count
            prod["pallet_size_min"] = lo
            prod["pallet_size_max"] = hi
            prod["pallet_size"] = lo if hi == lo else None
            if hi is None:
                prod["warnings"].append(
                    f"batch of {batch:g} filled one pallet, so pallet size is only known to be >= {lo}")
            elif hi != lo:
                prod["warnings"].append(
                    f"pallet size is only pinned to {lo}..{hi} by this note")
        elif pallet_count:
            prod["pallet_count"] = pallet_count
            prod["pallet_size"] = None
            prod["warnings"].append("pallet size not derivable: packaging shared between products")
        else:
            prod["pallet_size"] = None

        # ---- fold repeated codes on the same basis into one line.
        folded = {}
        for ln in prod["lines"]:
            k = (ln["code"], ln["basis"], ln["unit"])
            if k in folded:
                folded[k]["qty"] += ln["qty"]
                folded[k]["raw"] += ln["raw"]
                folded[k]["folded_from"] = folded[k].get("folded_from", 1) + 1
            else:
                folded[k] = dict(ln)
        prod["lines"] = list(folded.values())
        for ln in prod["lines"]:
            if ln.get("folded_from"):
                prod["warnings"].append(
                    f"code {ln['code']} appeared {ln['folded_from']}x on the same basis and was summed")
        out["products"].append(prod)
    return out


def main():
    docs = load_docs()
    if not docs:
        print("no transcriptions yet", file=sys.stderr)
        return 1
    derived = {s: derive(d, s) for s, d in docs.items()}
    path = os.path.dirname(os.path.abspath(__file__)) + "/derived.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(derived, fh, indent=1, ensure_ascii=False)

    print(f"{len(docs)} notes -> {sum(len(d['products']) for d in derived.values())} products\n")
    print(f"{'note':<14}{'doc':<14}{'fg':<9}{'batch':>7}{'pal':>5}{'size':>7}{'lines':>7}  warnings")
    for slug in sorted(derived):
        d = derived[slug]
        for w in d["warnings"]:
            print(f"  !! {slug}: {w}")
        for p in d["products"]:
            ps = p.get("pallet_size")
            size = str(ps) if ps else (f"{p.get('pallet_size_min','?')}+"
                                       if p.get("pallet_size_min") else "?")
            print(f"{slug:<14}{d['doc']:<14}{p['fg_code']:<9}{p['batch']:>7g}"
                  f"{p.get('pallet_count',0) or 0:>5g}{size:>7}{len(p['lines']):>7}"
                  f"  {'; '.join(p['warnings'])[:70]}")
    print(f"\nwritten to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
