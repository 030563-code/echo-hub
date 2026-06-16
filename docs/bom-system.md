# Echo Barrier Hub — BOM explosion + master price editing

Built 2026-06-16. Extends the PO system: once an EB Group → SRO PO is **approved**, it
appears in the BOM section and is exploded into its bill of materials, with the Bamida
draft PO and SRO cost record split out. Master component prices are editable (role-gated)
and the edit reflects in every PO explosion immediately.

## Decisions (Dean, 2026-06-16)
- **Master `component_detail` only** — the PO explosion is a LIVE read of the mfg
  `bom_weekly_snapshot` (no per-PO snapshot); editing writes the master.
- **BOM + Bamida draft view (record only)** — no Bamida sub-PO / Xero; just the
  explosion + a Bamida-costs-only draft view. SRO costs recorded alongside, excluded
  from the Bamida PO.
- **Auto on SRO approval** — approved SRO POs surface automatically and explode live.

## How it works
- **Source:** mfg project `cdkpczinzhykcdbfoobn`, `bom_weekly_snapshot` (latest week).
  Per `model_code`: `component_detail` (jsonb materials), `bamida_man/print_eur`,
  `sro_components/duty_8pct/admin_eur`, `fx_gbp_eur`.
- **SKU → model:** `po_product_catalog.bom_model_code` (e.g. `EBH9NA → H9`). Accessories
  (BUN/HK/EBVFK) map to NULL → no BOM (shown as "no BOM mapping").
- **Explosion (per SRO-PO line):** components × line qty; **Bamida draft PO line** =
  (Σ component.extended_eur + bamida_man + bamida_print) × qty; **SRO cost (record)** =
  (sro_components + sro_duty_8pct + sro_admin) × qty. Pure live read — nothing stored.
- **Editing (master):** `bom.edit` capability. Edits `component_detail` + the 5 cost
  inputs for the latest-week row, recomputes `extended_eur` (unit × qty) +
  `bamida_total`/`sro_total`/`bom_total`, writes to mfg via the mfg **service-role**
  client *after* the `bom.edit` gate (mfg has no auth users), and logs before/after to
  `public.bom_edit_log` (the price history a spreadsheet can't keep).

## Files
- migration `supabase/migrations/20260616000000_hub_bom_master_edit.sql` (ops; applied):
  `po_product_catalog.bom_model_code` (+seed), `bom.edit` capability, `bom_edit_log`.
- `src/lib/bom.ts` — `loadSroPoBoms()` (live explosion) + `loadBomMaster()` (server-only).
- `src/app/actions/bom/update-bom.ts` — `updateBomComponentDetail` (bom.edit, mfg write + audit).
- `src/app/(dashboard)/bom/{page.tsx, bom-section.tsx}` — tabs: SRO Order BOMs + Master Prices (+ editor).

## To use / verify
- Grant `bom.edit` to whoever updates prices (Yuri/Juraj); `bom.view` to viewers.
  Today only super-admins hold them.
- The explosion needs `MFG_SUPABASE_URL` + `MFG_SUPABASE_SERVICE_ROLE_KEY` (already used
  by the read-only BOM viewer). The edit path REUSES that mfg service-role key to WRITE —
  so that key now has write impact on mfg; keep it server-side only (it already is).
- Test with a **barrier** PO (e.g. `EBH9NA`) to see a real explosion — accessory-only POs
  show "no BOM mapping" by design.

## Open / confirm
- **`EBH9XNA → H9X 2.1W`** is a guess (H9X 1.5W also exists). Confirm the right variant.
- **Bamida PO composition** assumes `components + bamida_man + bamida_print` per your
  spec; note `bamida_total_eur` in the source = man + print only. All fields are shown in
  the editor/explosion so you can sanity-check.
- Editing writes the **latest week's** row; the weekly mfg pipeline may add a new week —
  carry-forward of edits across weeks is not handled (per the "master only" choice).
