# Demo-data manifest — Andy demo, seeded 2026-08-09

**Purpose:** run the full MRP system (demand → DDMRP buffers → spikes → materials
gate → Monte Carlo → container fill → PO-chain draft) end-to-end on realistic
example data while the real feeds are still thin. Everything listed here is
fabricated, marked, and reversible. **Nothing touches Xero, Slack or n8n** —
the seed batches and the drafting RPC suppress/scrub the webhook side effects
(verified: 0 rows in `net.http_request_queue`, 0 outbound responses).

Batch tag: `andy-demo-2026-08-09` · DB: ops `korylyniwsqtsvzuzydg`
Generator: `scripts/demo/` (deterministic, seed 20260809) → `scripts/demo/out/`

## What was INSERTED (all marker-identifiable)

| Table | Rows | Marker |
|---|---|---|
| mrp_demand_events | 453 (451 `demo_seed` + 2 `hubspot_deal` firm) | `source_ref like 'DEMO-%'` |
| deals_registry | 9 (6 pipeline, 2 late-stage spikes, 1 closed-won) | `hubspot_deal_id like 'DEMO-%'` |
| purchase_orders | 5 seeded + 3 engine-drafted | `po_number like 'DEMO-%'` / `like 'MRPD-%'` |
| purchase_order_lines | 26 seeded + 3 drafted | via their POs |
| po_line_receipts | 23 | via their POs |
| shipment_contents | 3 | `spot_id like 'DEMO-SPOT-%'` |
| mrp_lead_time_actuals | 48 (12 × mfg/ocean/customs/door) | `spot_id = 'DEMO'` |
| mrp_stage_weights | 1 | `stage_id = 'demo_late_stage'` |
| mrp_demo_seed_registry | (the audit table itself) | dropped by teardown |

## What was UPDATED (prior values captured in `mrp_demo_seed_registry`)

- `warehouse_stock_levels` — 23 NA rows counted (US-BAL/US-SBD/CA-HAM); EBH9NA
  deliberately tuned to a plausible red (350/100/50). Prior: all zero, never counted.
- `shipment_contents` — 11 stale live rows (Feb/Mar-2026 ETAs, still `on_water`)
  flipped to `delivered`. These were Cargo seed rows, not live tracking.
- `mrp_buffer_profile` — 14 rows given demo `moq` / `container_qty` /
  `cbm_per_unit` (CBM figures are estimates, NOT Dave's real cube data).
- `mrp_buffer_profile.adu/cov/var_factor/dlt_days` — recomputed by the persisted
  engine run **from demo+real demand**; not registry-tracked (engine-owned).

## Engine output while demo data is live

- `mrp_spike_register` 2026-08-09: 3 rows (I-95 deal → EBH9NA+HKNA, Toronto → EBH10NA)
- Drafted chain `MRPD-20260809-01/-02/-03` (`status='requested'`, `requested_by='mrp-engine'`),
  EBH9NA ×559, rationale in `notes` — drafted at the moment EBH9NA breached red
  (NFP 964 ≤ red 1043).
- `mrp_buffer_status_daily` run 2026-08-09 (latest re-run, post-review-fix MC):
  14 rows, 0 red / 8 yellow / 6 green — EBH9NA sits YELLOW **because its own
  drafted chain now counts as on-order** (NFP 1523), while corrected
  p_stockout reads 68.7% grade A (the chain lands at ~DLT, after most of the
  risk window). That zone-vs-MC tension is the Task-19 graduation story.
- 2026-08-09 adversarial review (14 agents): 3 code defects confirmed + fixed
  (commit 64189fd — MC size pool now week-aggregated, blocked-yellow draft
  leak, binary on-order starvation); teardown scoping hardened. Known accepted
  limitation: the draft RPC's idempotency is day-granular — a second same-day
  run with newly-red SKUs returns skipped.

## Schema changes that STAY after teardown (real migrations, applied live + in repo)

1. `20260809121500` — `mrp_lead_time_actuals` leg check now includes `'customs'`
2. `20260809124500` — `mrp_demand_events` source check now includes `'demo_seed'`
3. `20260809120000` + `20260809131000` — `mrp_draft_po_chain(jsonb, boolean)` RPC (v2 quiet mode)

## HOW TO DELETE EVERYTHING

1. Run `scripts/demo/out/teardown.sql` against the ops DB (MCP `execute_sql`, one
   transaction). It restores every UPDATE from the registry, deletes every
   insert marker-by-marker (including `MRPD-%` engine drafts), removes
   2026-08-09+ engine output, then drops the registry table.
   (Regenerate with `npx tsx scripts/demo/generate-demo-data.ts` if `out/` is missing.)
2. **Then run the engine once** (`npx dotenv-cli -e .env.local -- npx tsx
   scripts/mrp-dry-run.ts --persist`) so `mrp_buffer_profile` adu/cov/dlt
   recompute from real-only demand — the write-backs currently embed demo history.
3. Verify: `select count(*) from mrp_demand_events where source_ref like 'DEMO-%'` → 0;
   same for `deals_registry`, `purchase_orders ('DEMO-%'|'MRPD-%')`,
   `shipment_contents ('DEMO-SPOT-%')`, `mrp_lead_time_actuals ('DEMO')`,
   `mrp_stage_weights ('demo_late_stage')`; `warehouse_stock_levels` back to 0/null.

## Honesty notes (say these to anyone shown the demo)

- All demand before 2026-02 and most of 2025 is synthetic (`source='demo_seed'`,
  seasonal construction curve). Real Xero-derived history (134 events) is preserved
  untouched and interleaved.
- Depot stock counts, CBM/MOQ/container figures, lead-time actuals and the two
  spike deals are fabricated. The Bamida material stock, the BOM, and the
  materials ceilings (280 H9 capped by Kovové istenie) are REAL.
- The board's `bom_estimated` / `materials_map_provisional` flags remain true
  and honest: the BOM is a delivery-note estimate and the SKU→FG mappings are
  still unconfirmed (Dean gate §2j).
