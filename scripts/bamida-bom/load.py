#!/usr/bin/env python3
"""Load the delivery-note bills of materials.

Idempotent: every insert names the table's real unique constraint in
on_conflict, because PostgREST otherwise resolves ignore-duplicates against
the primary key, which is a generated uuid here and never collides.

Strictly additive: the products that already have a bill of materials are
never touched, only the ones that have none."""
import json, os, sys, urllib.request, urllib.error

EXISTING = {"000716", "000717", "000728", "000750", "000760"}
HERE = os.path.dirname(os.path.abspath(__file__))

e = {}
ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, _, v = line.partition("="); e[k.strip()] = v.strip()
KEY, URL = e["SUPABASE_SERVICE_ROLE_KEY"], e["NEXT_PUBLIC_SUPABASE_URL"]


def call(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as ex:
        print(f"  HTTP {ex.code} on {method} {path}: {ex.read().decode()[:500]}", file=sys.stderr)
        raise


IN_FEED = {str(r["ns_number"]) for r in call("GET", "bamida_material_stock?select=ns_number&limit=2000")}
derived = json.load(open(HERE + "/derived.json", encoding="utf-8"))

obs_rows, obs_lines_by_key, prod_rows, comp_rows = [], {}, [], []
for slug in sorted(derived):
    d = derived[slug]
    for p in d["products"]:
        key = (p["fg_code"], d["doc"])
        obs_rows.append(dict(
            fg_code=p["fg_code"], fg_label=p["fg_label"], source_doc=d["doc"],
            source_date=d.get("date"), source_po=d.get("po"), batch_size=p["batch"],
            pallet_count=p.get("pallet_count"), pallet_size_min=p.get("pallet_size_min"),
            pallet_size_max=p.get("pallet_size_max"), warnings=p["warnings"]))
        obs_lines_by_key[key] = [dict(
            component_code=str(l["code"]), component_desc=l["desc"], qty=round(l["qty"], 6),
            unit=l["unit"], basis=l["basis"], line_type=l["line_type"],
            raw_qty=l["raw"], in_stock_feed=str(l["code"]) in IN_FEED)
            for l in sorted(p["lines"], key=lambda x: (x["basis"], x["code"]))]

        if p["fg_code"] in EXISTING:
            continue
        lo, hi = p.get("pallet_size_min"), p.get("pallet_size_max")
        # The MINIMUM pallet size consistent with the note. Fewer units per
        # pallet means more pallets, more packaging drawn and a LOWER ceiling:
        # the safe direction to be wrong in.
        rng = (f"pallet size pinned to {lo}..{hi} by this note; the minimum is used, which "
               f"over-states packaging demand rather than under-stating it" if lo and hi and hi != lo
               else (f"pallet size at least {lo}, only one pallet was filled" if lo
                     else "no packing-bag line on this note, so no pallet size and no per-pallet demand"))
        prod_rows.append(dict(
            fg_code=p["fg_code"], fg_label=p["fg_label"], pallet_size=lo,
            source_doc=d["doc"], source_date=d.get("date"), source_batch=int(p["batch"]),
            source_po=d.get("po"),
            notes=(f"Derived from {d['doc']} ({d['date']}), batch {p['batch']:g}. {rng}. "
                   f"Transcribed line by line and independently re-read by a second pass. "
                   f"Estimate from a delivery note, not an official bill of materials.")))
        lines = [l for l in p["lines"] if l["basis"] in ("per_unit", "per_pallet")]
        for i, l in enumerate(sorted(lines, key=lambda x: (0 if x["basis"] == "per_unit" else 1,
                                                           x["line_type"], x["code"])), 1):
            comp_rows.append(dict(
                fg_code=p["fg_code"], line_no=i, component_code=str(l["code"]),
                component_desc=l["desc"][:120], qty=round(l["qty"], 6), unit=l["unit"],
                basis=l["basis"], line_type=l["line_type"],
                is_gating=(l["line_type"] == "material" and str(l["code"]) in IN_FEED),
                verified=False, source_kind="delivery_note_estimate", source_doc=d["doc"]))

print(f"loading {len(obs_rows)} observations, {sum(len(v) for v in obs_lines_by_key.values())} lines, "
      f"{len(prod_rows)} products, {len(comp_rows)} components")

# products first: mrp_bom_component has a foreign key onto them
call("POST", "mrp_bom_product?on_conflict=fg_code", prod_rows, "resolution=ignore-duplicates")
print(f"  products inserted")
for i in range(0, len(comp_rows), 200):
    call("POST", "mrp_bom_component?on_conflict=fg_code,component_code,basis",
         comp_rows[i:i + 200], "resolution=ignore-duplicates")
print(f"  components inserted")

call("POST", "mrp_bom_observation?on_conflict=fg_code,source_doc", obs_rows, "resolution=ignore-duplicates")
ids = {(o["fg_code"], o["source_doc"]): o["id"]
       for o in call("GET", "mrp_bom_observation?select=id,fg_code,source_doc&limit=500")}
lines = [dict(observation_id=ids[k], **ln) for k, v in obs_lines_by_key.items() for ln in v]
for i in range(0, len(lines), 300):
    call("POST", "mrp_bom_observation_line?on_conflict=observation_id,component_code,basis",
         lines[i:i + 300], "resolution=ignore-duplicates")
print(f"  observations + {len(lines)} lines inserted")
