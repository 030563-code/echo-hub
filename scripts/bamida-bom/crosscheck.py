#!/usr/bin/env python3
"""
Cross-check the newly derived bills of materials against two independent sources.

1. REGRESSION. Five finished goods already have a bill of materials in Supabase,
   derived in August from DIFFERENT delivery notes at DIFFERENT batch sizes. If
   the new notes reproduce those per-unit rates, the two-tier model is right and
   the numbers are stable. If they diverge, that is the finding, not a nuisance.

2. JOIN. Every material code must resolve to bamida_material_stock.ns_number or
   the manufacturing gate cannot see it. Unmatched codes are reported, never
   silently treated as zero stock.
"""
import json, os, re, sys, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
# .env.local at the repo root, four levels up from this file.
ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env.local")


def env():
    out = {}
    for line in open(ENV, encoding="utf-8"):
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def rest(path, key, url):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    e = env()
    key, url = e["SUPABASE_SERVICE_ROLE_KEY"], e["NEXT_PUBLIC_SUPABASE_URL"]

    old = rest("mrp_bom_component?select=fg_code,component_code,qty,unit,basis,line_type,is_gating&limit=2000", key, url)
    stock = rest("bamida_material_stock?select=ns_number,item_name,unit,quantity&limit=2000", key, url)
    stock_by = {str(s["ns_number"]): s for s in stock}

    derived = json.load(open(HERE + "/derived.json", encoding="utf-8"))

    # index the old bill of materials
    oldi = {}
    for r in old:
        oldi.setdefault(r["fg_code"], {})[(str(r["component_code"]), r["basis"])] = r

    # index the new one, keeping the note each product came from
    newi = {}
    for slug, d in derived.items():
        for p in d["products"]:
            newi.setdefault(p["fg_code"], []).append((slug, d["doc"], p))

    print("=" * 78)
    print("1. REGRESSION against the five bills of materials already in Supabase")
    print("=" * 78)
    any_regression = False
    for fg in sorted(oldi):
        obs = newi.get(fg)
        if not obs:
            print(f"\n{fg}: no new delivery note covers it. Existing rows untouched.")
            continue
        for slug, doc, p in obs:
            print(f"\n{fg}  old note vs {doc} ({slug}), new batch {p['batch']:g}")
            newl = {(l["code"], l["basis"]): l for l in p["lines"]}
            allk = sorted(set(oldi[fg]) | set(newl), key=lambda k: (k[1], k[0]))
            same = diff = onlyold = onlynew = 0
            rows = []
            for k in allk:
                o, n = oldi[fg].get(k), newl.get(k)
                if o and n:
                    a, b = float(o["qty"]), float(n["qty"])
                    tol = max(abs(a), abs(b)) * 0.005 + 1e-6
                    if abs(a - b) <= tol:
                        same += 1
                    else:
                        diff += 1
                        rows.append(("DIFFERS", k[0], k[1], f"{a:g}", f"{b:g}",
                                     (n.get("desc") or "")[:34]))
                elif o:
                    onlyold += 1
                    rows.append(("only in DB", k[0], k[1], f"{float(o['qty']):g}", "-", ""))
                else:
                    onlynew += 1
                    rows.append(("only in new", k[0], k[1], "-", f"{float(n['qty']):g}",
                                 (n.get("desc") or "")[:34]))
            print(f"   {same} rates agree, {diff} differ, {onlyold} only in the database, {onlynew} only in the new note")
            if diff:
                any_regression = True
            for r in rows:
                print(f"     {r[0]:<12}{r[1]:<8}{r[2]:<11}db={r[3]:<10}new={r[4]:<10}{r[5]}")

    print()
    print("=" * 78)
    print("2. JOIN to the live Bamida stock feed")
    print("=" * 78)
    unmatched, matched, unit_clash = {}, 0, []
    for fg, obs in sorted(newi.items()):
        for slug, doc, p in obs:
            for l in p["lines"]:
                if l["line_type"] != "material":
                    continue
                s = stock_by.get(l["code"])
                if s is None:
                    unmatched.setdefault(l["code"], [l["desc"], set()])[1].add(fg)
                else:
                    matched += 1
                    if s["unit"] and l["unit"] and s["unit"] != l["unit"]:
                        unit_clash.append((l["code"], l["desc"], l["unit"], s["unit"], fg))
    print(f"{matched} material lines resolve to a stock card.")
    print(f"{len(unmatched)} distinct codes do NOT. These become 'unknown', never zero:")
    for c, (d, fgs) in sorted(unmatched.items(), key=lambda x: -len(x[1][1])):
        print(f"   {c:<8}{d[:46]:<48}used by {len(fgs)} product(s)")
    if unit_clash:
        print(f"\nUNIT MISMATCHES ({len(unit_clash)}) - these would corrupt the ceiling maths:")
        for c, d, a, b, fg in unit_clash:
            print(f"   {c:<8}{d[:36]:<38}note={a:<5}stock={b:<5}{fg}")
    else:
        print("\nNo unit mismatches on any matched line.")

    print()
    print("=" * 78)
    print("3. PER-PALLET CONSTANTS across products (the check that proved the model)")
    print("=" * 78)
    pp = {}
    for fg, obs in newi.items():
        for slug, doc, p in obs:
            for l in p["lines"]:
                if l["basis"] == "per_pallet":
                    pp.setdefault(l["code"], {}).setdefault(round(l["qty"], 4), []).append(fg)
    for c in sorted(pp, key=lambda x: -sum(len(v) for v in pp[x].values())):
        vals = pp[c]
        desc = next((l["desc"] for _, obs in newi.items() for _, _, p in obs
                     for l in p["lines"] if l["code"] == c), "")
        flag = "CONSTANT" if len(vals) == 1 else "varies"
        detail = ", ".join(f"{v:g} x{len(f)}" for v, f in sorted(vals.items()))
        print(f"   {c:<8}{desc[:38]:<40}{flag:<10}{detail}")

    print()
    print("=" * 78)
    print("4. PALLET SIZE, reconciled across every note")
    print("=" * 78)
    print("A single note pins the pallet size only to a RANGE, because ceil() hides")
    print("the exact divisor. Intersecting the ranges from several notes narrows it.")
    print()
    bands = {}
    for fg, obs in newi.items():
        for slug, doc, p in obs:
            lo, hi = p.get("pallet_size_min"), p.get("pallet_size_max")
            if lo is None:
                continue
            bands.setdefault(fg, []).append((doc, p["batch"], p["pallet_count"], lo, hi))
    old_size = {r["fg_code"]: None for r in old}
    for prod in rest("mrp_bom_product?select=fg_code,pallet_size", key, url):
        old_size[prod["fg_code"]] = prod["pallet_size"]

    # group products by the panel size in their label, which is what sets the pallet
    fam = {}
    for fg, obs in newi.items():
        label = obs[0][2]["fg_label"]
        m = re.search(r"(\d{3,4})\s*[xX]\s*(\d{3,4})", label)
        fam.setdefault(m.group(0).replace(" ", "") if m else "unstated", []).append(fg)

    for fg in sorted(bands):
        lo = max(b[3] for b in bands[fg])
        his = [b[4] for b in bands[fg] if b[4] is not None]
        hi = min(his) if his else None
        db = old_size.get(fg)
        verdict = "exact" if hi == lo else (f"{lo}..{hi}" if hi else f">= {lo}")
        agree = "" if db is None else (
            "  agrees with the database" if (db >= lo and (hi is None or db <= hi))
            else f"  CONFLICTS with the database value {db}")
        print(f"   {fg:<9}{verdict:<12}from {len(bands[fg])} note(s)"
              f"{'  db=' + str(db) if db else '':<10}{agree}")
        for doc, batch, cnt, l, h in bands[fg]:
            print(f"       {doc:<13}batch {batch:>5g} in {cnt:>3g} pallet(s) -> {l}..{h if h else 'inf'}")

    print()
    print("   Grouped by panel size (products sharing a panel should share a pallet):")
    for size, fgs in sorted(fam.items()):
        got = [f for f in fgs if f in bands]
        if not got:
            continue
        lo = max(max(b[3] for b in bands[f]) for f in got)
        his = [b[4] for f in got for b in bands[f] if b[4] is not None]
        hi = min(his) if his else None
        print(f"      {size:<14}{', '.join(sorted(got)):<34}"
              f"{'exact ' + str(lo) if hi == lo else (str(lo) + '..' + str(hi) if hi else '>= ' + str(lo))}")

    return 1 if any_regression else 0


if __name__ == "__main__":
    sys.exit(main())
