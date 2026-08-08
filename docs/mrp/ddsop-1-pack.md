# DDS&OP #1 — meeting pack (Dean + Dave)

Generated 2026-08-08 from the live ops DB (`korylyniwsqtsvzuzydg`) and the MCS
mirror (`rmphqdopzvmirlooqnkv`). First meeting ~45 min; standing meeting 30 min
monthly thereafter. Every decision taken here gets logged to `mrp_ddsop_log`
(meeting_date + decisions jsonb + logged_by) — that table is the audit trail
the engine's "DDS&OP-tunable" constants point back to.

## 1. Purpose + standing agenda

The DDMRP buffer engine (v2) is running in **shadow mode**: it computes and
persists nightly buffer status but triggers nothing. DDS&OP (Demand Driven
Sales & Operations Planning) is the monthly human loop that owns every number
the engine treats as policy rather than measurement.

Standing agenda (30 min, monthly after #1):

1. **Buffer misses** — reds that became real stockouts, greens that overstocked
   (review `mrp_shadow_reds` + flap history since last meeting).
2. **ADU overrides** — thin-history SKUs on `adu_source='manual'`: still right?
   Any SKU with enough history to flip back to `auto`?
3. **Factors** — `lt_factor` / `var_factor` / `sku_class` sanity vs observed
   variability; DLT recalibration state (door actuals count vs the 10 minimum).
4. **Spike allowlist** — stage weights + `is_late_stage` flags vs how deals
   actually converted.
5. **Map freshness** — `mrp_bom_map` verified coverage, `bom_map_stale` /
   `bom_join_missing` warnings, alias table changes, MCS sync health.

## 2. Decisions needed at DDS&OP #1

### 2a. SKU classes (core / slow)

Trailing-180d US/CA demand per computed SKU (alias spellings rolled up:
`01-EBH9`→`EBH9NA`, `EBH10HERC`→`EBH10HERCNA`, `H8`→`EBH8NA`), queried from
`mrp_demand_events` 2026-08-08:

| SKU | Family | Units (180d) | Events (180d) | Suggested class | Decision |
|---|---|---:|---:|---|---|
| EBH9NA | EBH9 | 4,744 | 37 | core | |
| HKNA | HK | 1,189 | 10 | core | |
| EBH10HERCNA | EBH10HERC | 910 | 11 | core | |
| BUNNA | BUN | 808 | 6 | core | |
| EBH10NA | EBH10 | 430 | 2 | slow (borderline — volume core, 2 events) | |
| EBH9XNA | EBH9X | 388 | 6 | slow (borderline) | |
| EBH9ERNA | EBH9 | 124 | 2 | slow | |
| EBVFKNA | VFK | 100 | 10 | slow | |
| EBH8NA | EBH8 | 63 | 4 | slow | |
| FSCNA | FSCS | 5 | 2 | slow | |
| CCSNA | COMP | 4 | 2 | slow | |
| EBH9WNA | EBH9W | 0 | 0 | slow | |
| M1NA | M1 | 0 | 0 | slow | |
| V2NA | V2 | 0 | 0 | slow | |

The "Suggested class" column is a **suggestion only**, ranked by unit volume —
Dean + Dave decide. `sku_class` currently defaults to `'slow'` for all 14.

### 2b. ADU seeds (manual overrides where history is thin)

Engine-computed ADU (exactly the engine's formula: 180d US/CA demand with
alias rollup ÷ 180 — SQL identical to what the nightly run executes). The
engine flags `thin_history` below 5 events in the window; those rows are the
manual-override candidates (`adu_source='manual'` + agreed `adu`, optionally a
pinned `var_factor`):

| SKU | Computed ADU (u/day) | Events (180d) | Thin? | Manual ADU override | var_factor override |
|---|---:|---:|---|---|---|
| EBH9NA | 26.36 | 37 | | — (auto) | |
| HKNA | 6.61 | 10 | | — (auto) | |
| EBH10HERCNA | 5.06 | 11 | | — (auto) | |
| BUNNA | 4.49 | 6 | | — (auto) | |
| EBH10NA | 2.39 | 2 | thin | | |
| EBH9XNA | 2.16 | 6 | | — (auto) | |
| EBH9ERNA | 0.69 | 2 | thin | | |
| EBVFKNA | 0.56 | 10 | | — (auto) | |
| EBH8NA | 0.35 | 4 | thin | | |
| FSCNA | 0.03 | 2 | thin | | |
| CCSNA | 0.02 | 2 | thin | | |
| EBH9WNA | 0.00 | 0 | thin | | |
| M1NA | 0.00 | 0 | thin | | |
| V2NA | 0.00 | 0 | thin | | |

A zero-ADU SKU gets zero-width buffers (every unit of demand is a red) — if
EBH9WNA / M1NA / V2NA are still stocked products, they need a manual seed; if
they are dead SKUs, leave at zero and note it in the log.

### 2c. Stage weights (spike qualification input)

`mrp_stage_weights` census joined to deal counts in `deals_registry` — 26
stages, all non-terminal ones at the 0.2 placeholder. `closedwon = 1` and
`closedlost = 0` are **fixed** (definitional, not up for review). The
`stage_label` column is null throughout — the ids are HubSpot's internal stage
ids; label them from the HubSpot pipeline settings during (or before) the
meeting. What matters for the engine: `win_weight` (probability multiplier on
spike qty) and `is_late_stage` (only late-stage deals qualify as spikes at
all — today NO open stage is late-stage, so the spike register stays empty).

| Stage id | Deals | Placeholder weight | Real weight (fill in) | is_late_stage? (fill in) |
|---|---:|---:|---|---|
| 931aa327-b722-494f-aac2-63d4d2d0d358 | 502 | 0.2 | | |
| closedwon | 488 | 1 (fixed) | 1 | true (fixed) |
| 602a59e7-219a-4754-bd0a-89b3cf8ca05b | 357 | 0.2 | | |
| 6d7f01e5-b5f7-495e-8e78-e2a72caca474 | 177 | 0.2 | | |
| 2656054e-892b-497e-b2b3-8f8640bee940 | 121 | 0.2 | | |
| ebbe6ef1-c71b-4ae4-b967-7b15aec95027 | 103 | 0.2 | | |
| 7e248e4c-e1a8-40ae-aebb-c75ed4c05a22 | 87 | 0.2 | | |
| cfbab5be-64fa-4b37-b8f4-95525c980204 | 48 | 0.2 | | |
| 1170409275 | 20 | 0.2 | | |
| 3f5e750b-c1cb-46b6-aa8e-cbed58d0b94c | 18 | 0.2 | | |
| closedlost | 16 | 0 (fixed) | 0 | false (fixed) |
| 1270054246 | 13 | 0.2 | | |
| 1216649 | 12 | 0.2 | | |
| 1172530569 | 9 | 0.2 | | |
| 1216644 | 7 | 0.2 | | |
| fdf166e6-930a-4865-8ab9-5500ed73f388 | 5 | 0.2 | | |
| 1270054249 | 4 | 0.2 | | |
| Quote Created | 4 | 0.2 | | |
| 1216646 | 3 | 0.2 | | |
| 1216645 | 2 | 0.2 | | |
| 1270054250 | 2 | 0.2 | | |
| 744133 | 2 | 0.2 | | |
| 8f585de7-16f8-4cd3-88d5-12c512733f52 | 2 | 0.2 | | |
| ef3ed41c-fe44-400d-ad1c-075083b5e000 | 2 | 0.2 | | |
| 1266942995 | 1 | 0.2 | | |
| 744147 | 1 | 0.2 | | |

Minimum useful outcome from #1: mark the 2–3 genuinely late stages
(`is_late_stage=true`) with honest win weights — that alone turns the spike
layer on.

### 2d. Bamida asks

All 14 profiles currently carry the identical seed: **mfg 45d (a guess) +
ocean 21 + customs 9 = DLT 75d**, `lt_factor` 0.25, **MOQ 0**, and **no
container_qty / cbm_per_unit on any SKU**. Three asks for Bamida (route via
Juraj/Kamil):

| Ask | Current value | Needed for |
|---|---|---|
| Manufacturing lead time (order → ex-works), per SKU or family | 45d seed, uniform | DLT — every buffer zone scales with it |
| MOQ per SKU | 0 (unset) | order sizing (green zone floor) |
| Container CBM per unit, per SKU | null on all 14 | Phase-2 container fill (Task 15) — blocks that task's math |
| Priced invoices (*faktúra*) for POs `PO-00001292/1318/1322/1332/1335` | we have delivery notes only (quantities, no prices) | turns the verified BOM coefficients into a cost model |
| Why does `available_quantity` run so negative? | −165,717 m on orange thread vs 75,093 m physically on hand | if reservations never clear, that field is unusable — they may not know |

### 2e. EBHS→EBH9 history caveat — accept?

The UK/OZ backfill maps MCS item `EBHS` ("Echo Barrier H Series" — OZ's
dominant product code) to canonical `EBH9`. Descr evidence at backfill time:
**≤3% of EBHS unit volume mentions another variant (H10/H8/H3/H4)** — so EBH9
donor history carries up to ~3% per-variant impurity in OZ data. This only
touches the UK/OZ **donor** series (family-pooled statistics for the future MC
layer), never US/CA ADU.

> Decision: accept the ≤3% impurity ( ☐ accepted / ☐ not accepted — split
> EBHS by descr before Phase 3 ).

### 2f. Credit-note bounding (demand overstatement)

The backfill excludes `quant <= 0` lines and non-'S' itypes, so un-netted
credits slightly **overstate** demand. Measured on the live mirror
(2026-08-08, all-time):

| Branch | Gross 'S' units | Negative-'S' units | itype 'C' units | Overstatement |
|---|---:|---:|---:|---:|
| UK | 402,801 | 1,303 (24 lines) | 1 (581 lines — value-only credits) | **0.32%** |
| OZ | 22,133 | 120 (7 lines) | 0 (8 lines) | **0.54%** |

Per-SKU exception scan (gross ≥ 50 units, credit side > 5%): only UK item
`FC` (306 gross / 53 credits / 17.3%) — **not a mapped barrier product**, so it
never enters the ledger anyway. Recommendation (suggestion): accept region
levels ≤ 0.6% as noise, no netting logic. Decision rule: a per-SKU exception
is only worth building if a **mapped** SKU exceeds 5%.

Ready-to-run verification SQL (MCS mirror project `rmphqdopzvmirlooqnkv`):

```sql
-- Region-level bound
select branch,
  coalesce(sum(quant) filter (where itype='S' and quant>0),0) as gross_sale_units,
  coalesce(-sum(quant) filter (where itype='S' and quant<0),0) as neg_sale_units,
  coalesce(sum(abs(quant)) filter (where itype='C'),0)         as credit_note_units
from mcs_invoiceitem
group by 1 order by 1;

-- Per-SKU exceptions (>5% of gross, gross >= 50)
with s as (
  select branch, item,
    coalesce(sum(quant) filter (where itype='S' and quant>0),0) as gross,
    coalesce(-sum(quant) filter (where itype='S' and quant<0),0)
      + coalesce(sum(abs(quant)) filter (where itype='C'),0)    as credits
  from mcs_invoiceitem group by 1, 2
)
select branch, item, gross, credits,
       round(100.0 * credits / nullif(gross, 0), 1) as pct
from s where gross >= 50 and credits > 0.05 * gross
order by credits desc;
```

### 2g. FK fitting kits — map or keep skipping?

`FK` has no `product_code_master` entry, so the backfill skips it. Measured
volume: **UK 96,546 sale units (1,979 lines) + OZ 6,043 (136 lines) ≈ 102.6k
units** — by far the largest skipped genuine-product code. If fitting kits
should be buffered stock: add a master entry (+ `ITEM_ALIASES` entry), then
re-run `scripts/backfill-mcs-demand.ts` — it is idempotent (ON CONFLICT DO
NOTHING), so the re-run only adds the FK rows.

> Decision: add FK master entry + re-run backfill — ☐ yes / ☐ no (stays
> excluded, revisit when NA sells fitting kits).

### 2g-bis. 🔴 `NO_SKU_FOUND` — 2,691 units of NA demand with no SKU

**This is the NA-side twin of the FK gap above, and the highest-impact item in
this pack.** In the last 180 days, US/CA demand events carry
**2,691 units (17 invoice lines) under the parse-failure sentinel
`NO_SKU_FOUND`** — more volume than every SKU except EBH9NA. The engine
correctly excludes the sentinel from buffers, so this demand is invisible to
ADU, zones, and every trigger.

**Root cause is not our code:** the n8n hydration chain reads `hs_sku` off the
HubSpot *product* record; where that property is blank it writes the sentinel.
So the fix is data entry in HubSpot, not a deploy. Measured contents:

| Line-item name (HubSpot) | Units | Maps to | Note |
|---|---:|---|---|
| Fitting Kits | 2,112 | *(no NA SKU)* | same product family as the UK FK gap in 2g |
| Echo Barrier Reverse Hooks | 195 | `HKNA` "Hooks"? | confirm: variant or distinct SKU |
| **Echo Barrier H9 Window** | **155** | **`EBH9WNA`** | **exact catalog name match** |
| Fitting Kit (1 hook + 2 bungies) | 65 | `HKNA` + `BUNNA` | composite — decompose or new SKU |
| Vertical Fitting Kits | 60 | `EBVFKNA` | exact catalog name match |
| Echo Barrier H9 | 53 | `EBH9NA` | exact catalog name match |
| Security Cable | 50 | *(no NA SKU)* | accessory — buffer or ignore? |
| Freight to Vancouver | 1 | — | freight, correctly excluded |

**Why it changes a decision today:** `EBH9WNA` shows ADU 0 in this pack (§2b)
and renders red-with-no-action on the shadow board — but it has **155 units of
real demand** sitting in this bucket. Any buffer decision taken on its current
numbers is taken on wrong data. `EBH9NA` and `EBVFKNA` are similarly (mildly)
understated.

> Decisions:
> 1. Populate `hs_sku` on the HubSpot product records above — ☐ Dean/Jillian
>    action, target date ______
> 2. Re-hydrate the affected deals afterwards so the corrected SKUs flow into
>    the ledger (the capture trigger fires on line-item change, so a
>    re-hydration is sufficient — no manual ledger edits) — ☐ yes / ☐ no
> 3. "Reverse Hooks" = `HKNA` or its own SKU? — ☐ HKNA / ☐ new SKU: ______
> 4. Fitting Kits + Security Cable: buffer as NA SKUs (needs catalog entries,
>    pairs with the 2g decision) — ☐ yes / ☐ no

### 2h. MCS go-forward sync + BOM snapshot cadence

Two schedule-or-defer items:

1. **Weekly MCS demand re-scan** — n8n job running the committed backfill
   logic (`scripts/backfill-mcs-demand.ts`, idempotent) so UK/OZ demand keeps
   flowing after the one-shot backfill; includes promoting the script's
   hardcoded `ITEM_ALIASES` map to an ops table so mapping changes don't need
   a deploy. ☐ schedule weekly / ☐ defer
2. **`seed-bom-map` weekly cadence** — re-sync `mrp_bom_map` from the mfg BOM
   snapshots weekly. NOTE: `mrp_bom_map` is the **Echo-Barrier-supplied** BOM
   (PC350FR membrane, ACI acoustic infill, Datatag, slitting fee) and is
   **no longer read by the engine** — the manufacturing gate now uses
   `mrp_bom_component`. See also 2i. ☐ schedule weekly / ☐ defer

### 2i. 🔴 Two bills of materials that do not overlap — which is real?

`mrp_bom_map` (194 rows) lists components **Echo Barrier supplies** to Bamida:
`PC350FR-UV21` membrane, `ACI-T40` acoustic infill, `DAT-01` Datatag,
`GRP-SLTF` slitting fee. **None appear on any Bamida delivery note**, and
`PC350` returns **zero hits** in the 112-card Bamida stock feed. No acoustic
infill line appears on any note either — consistent with consigned stock that
is invisible to Bamida's system.

So a delivered barrier's cost is roughly *EB-supplied materials + Bamida
conversion + freight + duty*, and the delivery notes cover **one of those four
layers**.

> **Question for Kamil / Juraj:** are `PC350FR` and the Mehler skins on the
> delivery notes the **same material under two names**, or two genuinely
> different supply chains? And where is the acoustic infill tracked?
> ______

### 2j. 🔴 Materials gate — confirm the three SKU → finished-good mappings

The manufacturing BOM is now live, recovered from five Bamida delivery notes
and joined to live stock on `ns_number` (the ONIX code printed as "Kód
položky" on those notes). The engine reports, against physical stock:

| Hub SKU | Bamida FG | Buffer wants | Can build | Capped by |
|---|---|---|---|---|
| `EBH9NA` | `000716` H9 (1335×2050) | **1,501** | **280** | `1781` Kovové istenie — **4 pieces on hand** |
| `EBH8NA` | `000717` H8 (3650×2050) | 0 | 120 | `1781` Kovové istenie |
| `EBH10NA` | `000728` H10 | 315 | **48** | `900` Serge Ferrari mesh — 137 m² on hand |

**Nothing on a delivery note names a regional Hub SKU.** The mapping above is
inference from `product_code_master` and the panel dimensions, so the engine
marks it `materials_map_provisional` and **deliberately refuses to let it
block** — an inferred parts list halting a manufacturing trigger is the
expensive direction of error. Confirming flips `mrp_bom_sku_map.confirmed` and
the gate starts blocking.

> **Decision:**
> 1. `EBH9NA` = Bamida `000716`? — ☐ confirm / ☐ no: ______
> 2. `EBH8NA` = Bamida `000717`? — ☐ confirm / ☐ no: ______
> 3. `EBH10NA` = Bamida `000728`? ⚠️ that note is the **"Navarovacia reflexná
>    páska"** variant and carries a Serge Ferrari mesh skin *as well as* the
>    Mehler skin — it may be a variant, not base H10. — ☐ confirm / ☐ it is a
>    variant, needs its own SKU: ______
> 4. The other 11 buffered SKUs have no BOM (`materials_unmapped`). Which
>    should Bamida delivery notes be collected for? ______

### 2k. Should packaging consumables gate MANUFACTURING?

The BOM splits two ways: **per unit** (fabric, eyelets, webbing, thread) and
**per pallet** (packing bag, 16 wood screws, 10 washers, 6 texa screws, 20 m²
kašír, 50 m bag thread, metal securing) — 70 units/pallet on the 1335 mm
panels, 30 on the 3650 mm ones.

Right now the per-pallet consumables gate buildability along with everything
else, and that produces the odd headline above: **H9 caps at 280 because of
four pieces of a metal securing clip**, while the real constraint people care
about is fabric (Mehler 5097 has 24,586 m² — enough for ~8,600 units).

Arguably running out of packing screws delays *shipping* by a day; running out
of Mehler stops *manufacturing* for weeks. Those are not the same constraint
and the engine currently cannot tell them apart.

> **Decision:** set `mrp_bom_component.is_gating = false` for the pallet-level
> consumables (`1781`, `361`, `4898`, and the bag-thread rows)?
> - ☐ yes — gate on production materials only; packaging is a shipping issue
> - ☐ no — a pallet we cannot pack is a unit we cannot ship, keep them gating
> - ☐ split — keep gating but surface packaging separately: ______
>
> (Nine other codes — ink, print, ratchets, packing bags, fasteners — are
> already non-gating because Bamida does not expose them on our API account at
> all. That is a visibility limit, not a judgment call.)

### 2l. Capacity: the SPIDER welder looks like a shared bottleneck

The delivery notes also carry **labour and machine minutes**, which gives a
first capacity model. Total touch time per unit: H9 26 min · H10 29 · ND 52 ·
HT 3,5 58 · H8 65.

The single largest operation is `000582` **HF welding on "SPIDER XYZ" at 30
min/unit**, and it appears on **H8, HT 3,5 and Noise Defender** — but *not* on
H9, which uses VF-ZEMAT at 2 min/unit. If SPIDER is one machine on one shift,
the entire large-panel family shares a ceiling around **16 units/day** and
competes with itself, while H9 runs independently.

The engine does not model this yet (operations are stored but never gate).

> **Decision:** ☐ ask Bamida how many SPIDER machines / shifts, and whether the
> 30 min is machine time or operator time / ☐ out of scope for now

## 3. Dean's gate list (blockers before the trigger goes live)

- [ ] **Hydrator E2E POST test** — deal `46693967465`, expected 3-line
  reproduction (proves the capture path end-to-end before any sweep).
- [ ] **`MRP_CRON_SECRET` → Netlify** env var (the nightly route rejects
  unauthenticated calls until this lands).
- [ ] **n8n "MRP Cron Secret" header credential** — the scheduled caller's
  side of the same secret.
- [ ] **Physical depot counts** entered into the Hub warehouse editor — until
  then every SKU carries `stock_unverified` and on-hand is the receipts-ledger
  guess.
- [ ] **Kamil BOM mapping session** — worksheet ready:
  `docs/mrp/bamida-bom-mapping-worksheet.md` (11 components, Slovak
  instructions included). Unblocks `max_buildable` / `blocked_by_materials`.
- [ ] **Dave's 11-row legacy shipment↔PO mapping** — template in migration
  `20260807000300_hub_mrp_lead_time_actuals.sql`; unblocks door-leg lead-time
  actuals.
- [ ] **487-deal historical hydration sweep** — opt-in, throttled, only after
  the E2E proof above.

## 4. Shadow exit criteria (gate to Phase 2 cutover)

From the plan: **two consecutive weeks** in which

1. every red was actioned or explained — checklist source: **`mrp_shadow_reds`**
   (review twice weekly);
2. zero unexplained flapping — source: **`mrp_shadow_flap`** (every row =
   a zone transition needing an explanation; `prev_run_date` exposes cron
   gaps);
3. physical counts entered (gate item above).

Both views are live on ops with `security_invoker` (authenticated read flows
through the base table's RLS — probe-verified). Both are **empty today**:
`mrp_buffer_status_daily` has no persisted run yet, so the two-week clock
starts with the first nightly persist.

## 5. Standing risk register

- **Alias-chain trigger rider** — any future UI/write surface for
  `mrp_buffer_profile.alias_of` must ship a DB guard trigger enforcing the
  single-level contract; until then the engine warns (`alias_chain:<sku>-><target>`)
  instead of losing demand silently.
- **Unleashed stock-sync stays retired** — reviving it would overwrite the
  Hub's receipt-driven `warehouse_stock_levels` with an abandoned system's
  numbers.
- **Door leg is composite** — `mrp_lead_time_actuals` leg `'door'` covers
  ocean + customs + inland + logging delay; DLT = mfg + door. Never sum
  mfg + ocean + door.
- **Firm-demand 14d window** — the "won but not yet shipped" heuristic
  (`FIRM_DEMAND_WINDOW_DAYS`) is a tunable guess at close→dispatch latency;
  revisit when real dispatch data accumulates.
- **Shipped-PO / delivered-shipment double-count watch** — on-order dedup
  relies on shipment rows carrying `po_id`; all 11 live shipment rows are
  unlinked today, so watch this once links start landing.
- **`p_stockout` is empty by design** — the column (and its CI + data grade)
  waits for the Phase-3 Monte Carlo layer; nothing populates it during shadow.
