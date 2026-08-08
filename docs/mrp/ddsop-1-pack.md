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

### 2h. MCS go-forward sync + BOM snapshot cadence

Two schedule-or-defer items:

1. **Weekly MCS demand re-scan** — n8n job running the committed backfill
   logic (`scripts/backfill-mcs-demand.ts`, idempotent) so UK/OZ demand keeps
   flowing after the one-shot backfill; includes promoting the script's
   hardcoded `ITEM_ALIASES` map to an ops table so mapping changes don't need
   a deploy. ☐ schedule weekly / ☐ defer
2. **`seed-bom-map` weekly cadence** — re-sync `mrp_bom_map` from the mfg BOM
   snapshots weekly (keeps `last_seen_week` fresh; the engine's
   `bom_map_stale` flag stops firing spuriously). ☐ schedule weekly / ☐ defer

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
