# MRP Hybrid Manufacturing Trigger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the dead ROP engine with a DDMRP-style pooled-NA buffer system (net-flow trigger → pre-drafted EBUS→Group→SRO PO chain) plus a Monte Carlo stockout-probability layer, on top of repaired data plumbing.

**Architecture:** Nightly compute (n8n → `/api/mrp/run` route → TS engine → persisted `mrp_buffer_status_daily`), read-only `/mrp` page, Slack digest + red-zone pings. Demand flows through a unified `mrp_demand_events` ledger (two-stream: firm history + qualified pipeline spikes, hard dedup). Lead time decomposes into mfg+ocean+customs, self-recalibrating from `mrp_lead_time_actuals`. Materials gate from `bamida_material_stock` × `mrp_bom_map`.

**Tech Stack:** Next.js App Router (server actions + route handler), Supabase Postgres (ops `korylyniwsqtsvzuzydg`, mfg `cdkpczinzhykcdbfoobn`, MCS mirror `rmphqdopzvmirlooqnkv`), vitest (`tests/unit/*.test.ts`), n8n (`medes.app.n8n.cloud`), Slack channel `C0A2HNA7CUF`.

**Authority:** Design approved by Dean 2026-08-07 ("continue hybrid"). Full rationale + audit: Obsidian `Echo Barrier/Stocks Prediction Module/MRP Audit & Redesign Proposal — 2026-08-06.md`.

---

## Ground truth the implementer must know

- **Never read `deals_registry.deal_probability`** (0/2,003 populated — dead column). Pipeline weight comes from `mrp_stage_weights` (seeded manually, later empirical via `deal_stage_history`).
- **Date demand by close/invoice date, never `updated_at`.**
- **MCS hire (`itype='F'`) lines are fleet utilization, NOT consumption** — only `itype='S'` enters `mrp_demand_events`.
- A won deal moves pipeline-stream → history-stream. Never count it in both.
- `shipment_contents.po_reference` text join matches 0 rows — only `po_id` (uuid, added 2026-07-03) counts as linkage.
- Migration convention: SQL file in `supabase/migrations/YYYYMMDDHHMMSS_hub_<name>.sql`, applied to the **ops** project via the `supabase-echobarrier` MCP `apply_migration` (same content, same name).
- Commit style: `feat(mrp): …` / `fix(po): …`. Work on branch `feat/mrp-hybrid-trigger` (cut from `feat/po-system`).
- Depot on a receivable PO = `purchase_orders.from_entity` (depot leg is `DEPOT_TO_EB_GROUP`).

## External gates (people, not code — chase in parallel, none block Phase-0 code)

| Gate | Blocks | Owner |
|---|---|---|
| Physical depot stock count entered in Hub warehouse editor | Phase 1 go-live honesty (engine runs regardless, flagged `stock_unverified`) | Dave |
| Confirm mapping of the 11 legacy `shipment_contents` rows → POs (template in Task 5) | Backfill only; new rows link automatically | Dave |
| Add CA (later US) branch to the ODBC→Supabase MCS mirror | CA demand redundancy (CA still visible via HubSpot deals meanwhile) | Dave |
| Container CBM per SKU + Bamida MOQs | Task 15 (container program) | Dave/Bamida |
| Mfg lead time + BOM component→`item_name` mapping session | `dlt` seed refinement; materials gate accuracy | Kamil/Bamida |
| DDS&OP #1: seed ADU, SKU classes (core/slow), stage weights | Realistic zones (engine ships with conservative defaults + `seeded=false` badge) | Dean+Dave |

---

# Phase 0 — Data plumbing

### Task 1: `mrp_demand_events` ledger (migration + backfill)

**Files:**
- Create: `supabase/migrations/20260807000000_hub_mrp_demand_events.sql`

**Step 1: Write the migration**

```sql
-- Unified demand ledger for the MRP engine. One row = one realized demand event
-- (invoice line or closed-won deal line), dated by the COMMERCIAL date, never
-- updated_at. Hire (MCS itype F) is fleet utilization and must never land here.
create table public.mrp_demand_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  sku text not null,
  qty numeric not null check (qty > 0),
  region text not null check (region in ('US','CA','UK','OZ','FR','OTHER')),
  source text not null check (source in ('xero_invoice','hubspot_deal','mcs_invoice')),
  source_ref text not null,          -- invoice id / deal id / mcs docnum
  created_at timestamptz not null default now(),
  unique (source, source_ref, sku)   -- idempotent re-backfill
);
create index mrp_demand_events_sku_date on public.mrp_demand_events (sku, event_date desc);
alter table public.mrp_demand_events enable row level security;
create policy "authenticated_read_demand_events" on public.mrp_demand_events
  for select to authenticated using (true);

-- Backfill 1: Xero invoices (US + other). invoices_registry.line_items JSONB.
insert into public.mrp_demand_events (event_date, sku, qty, region, source, source_ref)
select
  coalesce(ir.invoice_date::date, ir.created_at::date),
  li->>'sku',
  (li->>'quantity')::numeric,
  case ir.currency when 'USD' then 'US' when 'CAD' then 'CA'
                   when 'GBP' then 'UK' else 'OTHER' end,
  'xero_invoice', ir.id::text
from public.invoices_registry ir
cross join lateral jsonb_array_elements(ir.line_items) li
where (li->>'quantity')::numeric > 0 and li->>'sku' is not null
on conflict do nothing;

-- Backfill 2: closed-won HubSpot deals with line items (dedup vs invoices is by
-- design two sources; Phase-1 engine reads invoices as primary for US and deals
-- for CA-post-MCS — see engine notes).
insert into public.mrp_demand_events (event_date, sku, qty, region, source, source_ref)
select
  coalesce(d.closed_at::date, d.updated_at::date),
  li->>'sku',
  (li->>'quantity')::numeric,
  coalesce(nullif(d.depot_region,''),'US'),
  'hubspot_deal', d.deal_id::text
from public.deals_registry d
cross join lateral jsonb_array_elements(d.line_items_raw) li
where d.deal_status = 'closedwon'
  and jsonb_typeof(d.line_items_raw) = 'array'
  and (li->>'quantity')::numeric > 0
on conflict do nothing;
```

> ⚠️ Before applying: verify column names `invoices_registry.invoice_date`, `line_items`, `deals_registry.closed_at`, `deal_id`, `depot_region` with one `information_schema` query; adjust the backfill (the table shapes were audited but not those exact JSON paths). If `closed_at` doesn't exist, use `updated_at` for the backfill ONLY and rely on the Task 2 trigger for correct dating going forward.

**Step 2: Apply via MCP** — `apply_migration(project korylyniwsqtsvzuzydg, name hub_mrp_demand_events)` with the file's content.

**Step 3: Verify** — `select source, region, count(*), sum(qty) from mrp_demand_events group by 1,2;` Expect: xero_invoice rows > 100; hubspot_deal rows ≥ 1.

**Step 4: Commit** — `git add supabase/migrations/… && git commit -m "feat(mrp): demand-events ledger + backfill"`

### Task 2: Stage history capture + demand-event trigger + stage weights

**Files:**
- Create: `supabase/migrations/20260807000100_hub_mrp_stage_history.sql`

**Step 1: Migration** (three objects):

```sql
-- 1) Stage transitions start accruing NOW so stage-entry win rates become
-- empirical later. deal_probability is dead (0/2003) — never read it.
create table public.deal_stage_history (
  id bigint generated always as identity primary key,
  deal_id text not null,
  old_status text,
  new_status text,
  changed_at timestamptz not null default now()
);
alter table public.deal_stage_history enable row level security;
create policy "authenticated_read_stage_history" on public.deal_stage_history
  for select to authenticated using (true);

create or replace function public.capture_deal_stage_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deal_status is distinct from old.deal_status then
    insert into deal_stage_history (deal_id, old_status, new_status)
    values (new.deal_id, old.deal_status, new.deal_status);
    -- closed-won → append demand events (dated today = true close date)
    if new.deal_status = 'closedwon' and jsonb_typeof(new.line_items_raw) = 'array' then
      insert into mrp_demand_events (event_date, sku, qty, region, source, source_ref)
      select current_date, li->>'sku', (li->>'quantity')::numeric,
             coalesce(nullif(new.depot_region,''),'US'), 'hubspot_deal', new.deal_id::text
      from jsonb_array_elements(new.line_items_raw) li
      where (li->>'quantity')::numeric > 0
      on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
create trigger trigger_capture_deal_stage_change
  before update on public.deals_registry
  for each row execute function public.capture_deal_stage_change();

-- 2) Pipeline weights: seeded at DDS&OP #1, replaced by empirical stage-entry
-- win rates once deal_stage_history has volume.
create table public.mrp_stage_weights (
  stage_id text primary key,       -- raw HubSpot stage UUID from deal_status
  stage_label text,
  win_weight numeric not null check (win_weight between 0 and 1),
  is_late_stage boolean not null default false,  -- spike-qualification allowlist
  seeded_manually boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.mrp_stage_weights enable row level security;
create policy "authenticated_read_stage_weights" on public.mrp_stage_weights
  for select to authenticated using (true);
```

**Step 2: Apply + verify** — update a test deal's status twice, confirm 2 history rows. **Step 3: Seed** `mrp_stage_weights` with the distinct `deal_status` UUIDs (`select deal_status, count(*) from deals_registry group by 1 order by 2 desc;`) and placeholder weights (0.2 default, flagged `seeded_manually`) — real values at DDS&OP #1. **Step 4: Commit.**

### Task 3: Receipts increment stock (pure helper + wire-in)

**Files:**
- Create: `src/lib/mrp/receipts.ts`
- Test: `tests/unit/mrp-receipts.test.ts`
- Modify: `src/app/actions/purchase-orders/receive-po.ts` (after line 124, and the `fullyReceived` block at 142-149)

**Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildStockIncrements } from '@/lib/mrp/receipts'

describe('buildStockIncrements', () => {
  it('aggregates received qtys per sku for the receiving depot', () => {
    const poLines = new Map([
      ['l1', { id: 'l1', sku: 'EBH9NA', quantity: 100 }],
      ['l2', { id: 'l2', sku: 'EBH10NA', quantity: 40 }],
    ])
    const received = [
      { lineId: 'l1', qty: 60 }, { lineId: 'l1', qty: 40 }, { lineId: 'l2', qty: 40 },
    ]
    expect(buildStockIncrements(received, poLines, 'US-BAL')).toEqual([
      { warehouse_code: 'US-BAL', sku: 'EBH9NA', delta: 100 },
      { warehouse_code: 'US-BAL', sku: 'EBH10NA', delta: 40 },
    ])
  })
  it('skips unknown lines and zero qtys', () => {
    const poLines = new Map([['l1', { id: 'l1', sku: 'EBH9NA', quantity: 10 }]])
    expect(buildStockIncrements([{ lineId: 'nope', qty: 5 }], poLines, 'US-BAL')).toEqual([])
  })
})
```

**Step 2:** `npx vitest run tests/unit/mrp-receipts.test.ts` → FAIL (module missing).

**Step 3: Implement `src/lib/mrp/receipts.ts`**

```ts
export interface ReceiptLine { lineId: string; qty: number }
export interface POLineLite { id: string; sku: string; quantity: number }
export interface StockIncrement { warehouse_code: string; sku: string; delta: number }

/** Pure: received batch → per-sku stock deltas for the receiving depot. */
export function buildStockIncrements(
  received: ReceiptLine[], poLines: Map<string, POLineLite>, depot: string,
): StockIncrement[] {
  const bySku = new Map<string, number>()
  for (const r of received) {
    const line = poLines.get(r.lineId)
    if (!line || r.qty <= 0) continue
    bySku.set(line.sku, (bySku.get(line.sku) ?? 0) + r.qty)
  }
  return [...bySku.entries()].map(([sku, delta]) => ({ warehouse_code: depot, sku, delta }))
}
```

**Step 4:** test passes. **Step 5: Wire into `recordReceipt`** — after the successful `po_line_receipts` insert (line 124): fetch `from_entity` in the PO select (line 66), then via `createAdminClient()` upsert stock:

```ts
// Physical stock: receipts are the ONLY automatic writer of warehouse_stock_levels.
const increments = buildStockIncrements(lines, poLines, po.from_entity)
for (const inc of increments) {
  const { error } = await admin.rpc('increment_stock', {
    p_warehouse: inc.warehouse_code, p_sku: inc.sku, p_delta: inc.delta,
  })
  if (error) console.error('stock increment failed', inc, error.message)
}
```

with a companion migration `20260807000200_hub_increment_stock_rpc.sql`:

```sql
create or replace function public.increment_stock(p_warehouse text, p_sku text, p_delta numeric)
returns void language sql security definer set search_path = public as $$
  insert into warehouse_stock_levels (warehouse_code, sku, quantity_on_hand, last_counted_at, updated_at)
  values (p_warehouse, p_sku, p_delta, now(), now())
  on conflict (warehouse_code, sku) do update
    set quantity_on_hand = warehouse_stock_levels.quantity_on_hand + p_delta,
        updated_at = now();
$$;
```

> Check first that `warehouse_stock_levels` has a unique constraint on `(warehouse_code, sku)`; add one in this migration if missing. Update the stale comment at receive-po.ts:13.

**Step 6:** `npm run typecheck && npx vitest run` → green. **Step 7: Commit** `feat(mrp): receipts increment depot stock`.

### Task 4: Drain in-transit + lead-time actuals

**Files:**
- Create: `supabase/migrations/20260807000300_hub_mrp_lead_time_actuals.sql`
- Modify: `src/app/actions/purchase-orders/receive-po.ts` (inside the `fullyReceived` block)

**Step 1: Migration** — `mrp_lead_time_actuals(id, po_id, spot_id, leg text check (leg in ('mfg','ocean','door')), days numeric, observed_at)` + RLS read. **Step 2: In `recordReceipt`**, when `fullyReceived`: mark linked shipments delivered and log the observation:

```ts
const nowIso = new Date().toISOString()
const { data: shipRows } = await admin
  .from('shipment_contents')
  .select('id, shipped_at')
  .eq('po_id', poId)
  .neq('status', 'delivered')
await admin.from('shipment_contents')
  .update({ status: 'delivered', delivered_at: nowIso })
  .eq('po_id', poId).neq('status', 'delivered')
for (const s of shipRows ?? []) {
  if (!s.shipped_at) continue
  const days = (Date.parse(nowIso) - Date.parse(s.shipped_at)) / 86_400_000
  if (days > 0 && days < 365)
    await admin.from('mrp_lead_time_actuals').insert({ po_id: poId, leg: 'door', days })
}
```

**Step 3: Legacy backfill template** (needs Dave): a commented SQL block in the migration mapping the 11 existing `shipment_contents.id` → `purchase_orders.id`, left as `-- TODO(Dave)` pairs. **Step 4: Unit-test the day-count edge cases** (pure date math extracted to `src/lib/mrp/receipts.ts` as `transitDays(shippedAt, deliveredAt)`), run, commit `feat(mrp): drain in-transit on receipt + lead-time capture`.

### Task 5: `mrp_bom_map` + seed from mfg BOM snapshots

**Files:**
- Create: `supabase/migrations/20260807000400_hub_mrp_bom_map.sql`
- Create: `scripts/seed-bom-map.ts`

**Step 1: Migration** — `mrp_bom_map(finished_sku text, component_code text, component_desc text, qty_per numeric, bamida_item_name text null, verified boolean default false, primary key (finished_sku, component_code))` + RLS read.
**Step 2: Seed script** (run with `SUPABASE_OPS_URL/KEY` + `SUPABASE_MFG_URL/KEY` env): read latest-week `bom_weekly_snapshot.component_detail` per `model_code` (mfg project — 22 models, fields `code/desc/qty`), map `model_code` → Hub SKU via `product_code_master`, upsert into `mrp_bom_map` with `bamida_item_name = null`.
**Step 3: Run + verify** — expect ~22 SKUs × 3–10 components; print unmatched `model_code`s.
**Step 4: Generate the Kamil worksheet** — `select distinct component_code, component_desc from mrp_bom_map where bamida_item_name is null` exported CSV alongside the 112 `bamida_material_stock.item_name`s → the mapping session fills `bamida_item_name` + `verified=true`.
**Step 5: Commit** `feat(mrp): bom map seeded from mfg snapshots`.

### Task 6: MCS UK/OZ demand backfill (one-off script)

**Files:** Create: `scripts/backfill-mcs-demand.ts`

Read `mcs_invoiceitem` (MCS mirror project) `where itype = 'S'` joined to `mcs_invoicehdr` for dates, map `item` → Hub SKU via `product_code_master` (`code_uk` for UK branch, OZ codes for OZ), insert `mrp_demand_events (source='mcs_invoice', region=branch)` in 1,000-row batches, idempotent via the unique key. Verify: `select region, count(*), min(event_date), max(event_date) from mrp_demand_events where source='mcs_invoice' group by 1;` → UK ≈ 8k rows spanning 2011→2026. Commit `feat(mrp): UK/OZ demand history backfill`.

### Task 7: n8n — hydrate line items on closed-won deals

Not a repo change. Via `n8n-echobarrier` MCP: extend the HubSpot→Supabase sync so `line_items_raw` is fetched for deals entering `closedwon` (today only ~7.5% of deals carry line items — quote-accepted-only hydration). Acceptance: close a test deal → `deals_registry.line_items_raw` populated → Task 2 trigger writes `mrp_demand_events` rows.

---

# Phase 1 — Buffer engine (shadow mode)

### Task 8: Engine tables migration

**Files:** Create: `supabase/migrations/20260807000500_hub_mrp_buffer_engine.sql`

`mrp_buffer_profile(sku pk, sku_class text check (sku_class in ('core','slow')) default 'slow', adu numeric, adu_source text default 'auto', dlt_days int default 75, mfg_lt int default 45, ocean_lt int default 21, customs_lt int default 9, lt_factor numeric default 0.25, var_factor numeric, cov numeric, moq int default 0, container_qty int, cbm_per_unit numeric, seeded boolean default false, updated_at)` — seeded with one row per `product_code_master` SKU.
`mrp_buffer_status_daily(run_date, sku, on_hand, in_transit, on_order, firm_demand, qualified_spikes, nfp, projected_nfp, red, yellow_top, green_top, zone text, action_qty, max_buildable, blocked_by_materials boolean, p_stockout numeric null, p_stockout_ci numeric null, data_grade text, flags jsonb, primary key (run_date, sku))`.
`mrp_spike_register(deal_id, sku, qty, due_date, weight, qualified, run_date)`.
`mrp_ddsop_log(id, meeting_date, decisions jsonb, logged_by)`.
All RLS: authenticated read; service-role writes. Apply, verify seed count = 22, commit.

### Task 9: Pure buffer math — `src/lib/mrp/buffers.ts` (the heart; full TDD)

**Files:** Create: `src/lib/mrp/buffers.ts` · Test: `tests/unit/mrp-buffers.test.ts`

**Step 1: Failing tests** (write all, run, watch fail):

```ts
import { describe, it, expect } from 'vitest'
import { computeZones, computeNFP, zoneFor, qualifySpikes, varFactorFromCov } from '@/lib/mrp/buffers'

const profile = { adu: 10, dltDays: 75, ltFactor: 0.25, varFactor: 0.6, moq: 0, containerQty: 0 }

describe('computeZones', () => {
  it('DDMRP zone math: yellow=ADU·DLT, green=max(ADU·DLT·LTf, MOQ, container), red=base·(1+VF)', () => {
    const z = computeZones(profile)
    expect(z.yellow).toBe(750)                    // 10*75
    expect(z.green).toBe(188)                     // ceil(10*75*0.25)
    expect(z.red).toBe(300)                       // ceil(187.5*(1+0.6))
    expect(z.yellowTop).toBe(z.red + z.yellow)    // 1050
    expect(z.greenTop).toBe(z.red + z.yellow + z.green) // 1238
  })
  it('green respects MOQ and container quantity', () => {
    expect(computeZones({ ...profile, moq: 400 }).green).toBe(400)
    expect(computeZones({ ...profile, containerQty: 500 }).green).toBe(500)
  })
  it('zero ADU collapses zones to MOQ-only green, zero red — never NaN', () => {
    const z = computeZones({ ...profile, adu: 0, moq: 100 })
    expect(z).toEqual({ red: 0, yellow: 0, green: 100, yellowTop: 0, greenTop: 100 })
  })
})

describe('varFactorFromCov', () => {
  it('maps measured CoV to DDMRP variability factor', () => {
    expect(varFactorFromCov(0.5)).toBe(0.4)
    expect(varFactorFromCov(1.5)).toBe(0.6)
    expect(varFactorFromCov(3.2)).toBe(1.0)
    expect(varFactorFromCov(null)).toBe(1.0)      // unknown → most conservative
  })
})

describe('computeNFP', () => {
  it('NFP = on_hand + on_order_deduped + in_transit − firm; projected subtracts weighted spikes', () => {
    const r = computeNFP({ onHand: 100, inTransit: 200, onOrder: 300, firmDemand: 150,
      spikes: [{ qty: 200, weight: 0.5, qualified: true }, { qty: 999, weight: 0.9, qualified: false }] })
    expect(r.nfp).toBe(450)
    expect(r.projectedNfp).toBe(350)              // only qualified spikes count
  })
})

describe('zoneFor', () => {
  const zones = { red: 100, yellow: 400, green: 150, yellowTop: 500, greenTop: 650 }
  it('classifies by NFP vs zone tops and sizes the order to green-top', () => {
    expect(zoneFor(650, zones)).toEqual({ zone: 'green', actionQty: 0 })
    expect(zoneFor(450, zones)).toEqual({ zone: 'yellow', actionQty: 200 })
    expect(zoneFor(90, zones)).toEqual({ zone: 'red', actionQty: 560 })
  })
})

describe('qualifySpikes', () => {
  it('spike = qty ≥ threshold, due inside horizon, late-stage only', () => {
    const today = new Date('2026-08-07')
    const out = qualifySpikes([
      { dealId: 'a', qty: 60, dueDate: '2026-09-20', lateStage: true,  weight: 0.4 },
      { dealId: 'b', qty: 10, dueDate: '2026-09-20', lateStage: true,  weight: 0.4 }, // below threshold
      { dealId: 'c', qty: 80, dueDate: '2027-03-01', lateStage: true,  weight: 0.4 }, // outside horizon
      { dealId: 'd', qty: 80, dueDate: '2026-09-01', lateStage: false, weight: 0.4 }, // early stage
    ], { redZone: 100, horizonDays: 105, today })
    expect(out.map(s => s.dealId)).toEqual(['a'])
  })
})
```

**Step 2:** run → FAIL. **Step 3: Implement**

```ts
export interface BufferProfile {
  adu: number; dltDays: number; ltFactor: number; varFactor: number
  moq: number; containerQty: number
}
export interface Zones { red: number; yellow: number; green: number; yellowTop: number; greenTop: number }

export function varFactorFromCov(cov: number | null): number {
  if (cov == null) return 1.0
  if (cov < 1) return 0.4
  if (cov <= 2) return 0.6
  return 1.0
}

export function computeZones(p: BufferProfile): Zones {
  const yellow = Math.ceil(p.adu * p.dltDays)
  const redBase = p.adu * p.dltDays * p.ltFactor
  const red = Math.ceil(redBase * (1 + p.varFactor))
  const green = Math.max(Math.ceil(redBase), p.moq, p.containerQty)
  return { red, yellow, green, yellowTop: red + yellow, greenTop: red + yellow + green }
}

export interface SpikeInput { qty: number; weight: number; qualified: boolean }
export function computeNFP(i: { onHand: number; inTransit: number; onOrder: number;
  firmDemand: number; spikes: SpikeInput[] }) {
  const nfp = i.onHand + i.inTransit + i.onOrder - i.firmDemand
  const spikeLoad = i.spikes.filter(s => s.qualified)
    .reduce((a, s) => a + s.qty * s.weight, 0)
  return { nfp, projectedNfp: nfp - spikeLoad }
}

export function zoneFor(nfp: number, z: Zones): { zone: 'red'|'yellow'|'green'; actionQty: number } {
  if (nfp > z.yellowTop) return { zone: 'green', actionQty: 0 }
  const actionQty = z.greenTop - nfp
  return { zone: nfp <= z.red ? 'red' : 'yellow', actionQty }
}

export interface SpikeCandidate { dealId: string; qty: number; dueDate: string; lateStage: boolean; weight: number }
export function qualifySpikes(cands: SpikeCandidate[],
  opts: { redZone: number; horizonDays: number; today: Date }) {
  const threshold = 0.5 * opts.redZone
  const horizonMs = opts.horizonDays * 86_400_000
  return cands.filter(c => c.lateStage && c.qty >= threshold
    && Date.parse(c.dueDate) - opts.today.getTime() <= horizonMs
    && Date.parse(c.dueDate) >= opts.today.getTime() - 86_400_000)
}
```

**Step 4:** run → PASS (fix the zero-ADU zone test against implementation exactly). **Step 5: Commit** `feat(mrp): DDMRP buffer math (zones, NFP, spikes)`.

### Task 10: Engine runner + `/api/mrp/run`

**Files:**
- Create: `src/lib/mrp/engine.ts` (assembles inputs → writes `mrp_buffer_status_daily`)
- Create: `src/app/api/mrp/run/route.ts`
- Test: `tests/unit/mrp-engine.test.ts` (pure aggregation helpers with stubbed rows — follow `tests/stubs` pattern)

Engine input queries (admin client, all per-SKU over `product_code_master` — no allowlist):
- `on_hand`: `sum(quantity_on_hand)` from `warehouse_stock_levels` **grouped by sku across depots** (fixes overwrite bug); flag `stock_unverified` until any `last_counted_at` is non-null.
- `in_transit`: `sum(qty)` from `shipment_contents where status <> 'delivered'`.
- `on_order`: open PO lines (`status in ('requested','approved','shipped')`, depot leg only) **minus** qty of shipment rows linked via `po_id` to those POs (dedup — audit finding 3; `shipped` status now included).
- `firm_demand`: qualified spike deals that are `closedwon`-but-unshipped + committed orders due ≤ horizon.
- ADU auto-calc: trailing-180d `mrp_demand_events` (region in US/CA) ÷ 180 per SKU; CoV over trailing-52 ISO weeks **including zero weeks**; write back to `mrp_buffer_profile` when `adu_source='auto'`.
- Spikes: open deals with line items × `mrp_stage_weights` (late-stage allowlist) → `qualifySpikes` → `mrp_spike_register`.
- Materials: `max_buildable = min(floor(greatest(available_quantity,0) / qty_per))` over verified `mrp_bom_map` rows; null (badge `materials_unverified`) when unmapped.

Route handler: `POST /api/mrp/run` with `authorization: Bearer ${process.env.MRP_CRON_SECRET}` (401 otherwise); runs engine; returns `{run_date, skus, reds, yellows, blocked}`. Commit `feat(mrp): nightly engine + run endpoint`.

### Task 11: n8n "MRP Nightly" workflow

Via `n8n-echobarrier` MCP: Schedule 06:45 Europe/London (after the 06:00 Bamida sync) → HTTP POST `/api/mrp/run` (header auth cred) → fetch today's `mrp_buffer_status_daily` (Supabase cred `TiImkZV6FBOg0vLW`) → Slack `C0A2HNA7CUF` (cred `oztDDBQlPJUEjepL`): **ping immediately** for any SKU newly red / newly blocked / new qualified spike; **Monday digest** = full board table. Message format per design §8 (drivers + buildable + container fill). Remember the platform traps: `publish_workflow` after building, verify credentials attached via `get_workflow_details`, `resource:"message"` explicit on Slack nodes.

### Task 12: `/mrp` page v2 (shadow section)

**Files:** Modify: `src/app/(dashboard)/mrp/page.tsx`, `mrp-client.tsx`; Create: `src/app/(dashboard)/mrp/v2-actions.ts`

Read-only fetch of latest `mrp_buffer_status_daily` + `mrp_buffer_profile`; render a "v2 (shadow)" table above the legacy board: zone chip, NFP vs zone tops, action qty, projected-NFP second needle, `max_buildable`, badges (`stock_unverified`, `materials_unverified`, `seeded=false`), `p_stockout` column rendered "—" while null. Keep legacy board untouched below. Remove the hardcoded `{90}` display (page.tsx:68) in favor of profile `dlt_days`. Commit `feat(mrp): v2 shadow board`.

### Task 13: Shadow-run + DDS&OP #1

- Create SQL view `mrp_shadow_diff` (v2 zone vs legacy status per SKU per day) — reviewed twice weekly for 2–3 weeks.
- DDS&OP #1 (Dean+Dave, 30 min): enter physical counts; set `sku_class` (core/slow) per SKU; seed ADU overrides where history is thin (`adu_source='manual'`); set stage weights; confirm `mfg_lt` guess with Bamida's answer; log everything to `mrp_ddsop_log`.
- Exit criteria for Phase 2: two consecutive weeks where every v2 red was either actioned or explained, zero unexplained flapping, counts entered.

---

# Phase 2 — Cutover (gated on shadow exit criteria)

**Task 14:** Remove legacy ROP path (`actions.ts` formulas), point the page at v2 only. `git rm` nothing — keep file history; delete dead exports. Commit `feat(mrp): cut over to buffer engine`.
**Task 15:** `src/lib/mrp/container.ts` — greedy container fill: all red SKUs to green-top first, then yellow by `(greenTop − NFP)` desc, constrained by `cbm_per_unit × qty ≤ container CBM` (needs Dave's CBM data), respect MOQ. Full vitest suite (fill ordering, CBM cap, MOQ rounding). Commit.
**Task 16:** Trigger → pre-drafted PO chain: on red (and unblocked), call the existing Hub PO-creation server actions to raise the 3-leg chain with `status='requested'`, lines = container program, notes = trigger rationale; Slack ping links to the approval screen. Idempotency: skip if an open Hub PO already covers the SKU (per the on-order dedup). Commit `feat(mrp): red-zone pre-drafts PO chain`.

# Phase 3 — Monte Carlo layer (gated on `mrp_demand_events` ≥ 20 events for a SKU family, UK donor ready)

**Task 17:** `src/lib/mrp/montecarlo.ts` + `tests/unit/mrp-montecarlo.test.ts` (seeded RNG — mulberry32 — for deterministic tests). Core algorithm:

```ts
// Per SKU: Willemain-style bootstrap of lead-time demand + pipeline branches.
// 1. From mrp_demand_events (region US/CA; family-pooled UK sizes when local
//    events < 20): weekly occurrence two-state Markov chain (p01, p11) +
//    empirical order-size list.
// 2. Per iteration i of 10_000:
//    L_i   = mfgDays() + oceanDays() + customsDays()   // empirical from
//            mrp_lead_time_actuals when n≥10 per leg, else Triangular seeds
//            (45,45,75) / (17,21,31) / (5,9,21)
//    dem_i = walk the Markov chain over ceil(L_i/7) weeks; on active weeks draw
//            size = jitter(randomChoice(sizes))        // jitter: 1 + U(-0.25,0.25)
//    dem_i += Σ_j Bernoulli(weight_j) × qty_j          // qualified spikes due < L_i
//    short_i = dem_i > onHand + arrivalsWithin(L_i)
// 3. p_stockout = mean(short); CI via 10 batch means; data_grade A/B/C by local
//    event count (≥20 / 5–19 / <5).
```

Write `p_stockout`, `p_stockout_ci`, `data_grade` into the nightly run (engine calls it after zones). UI: confidence chip; CI wider than 0.30 downgrades a red chip to yellow + "collect data". Commit per TDD steps.
**Task 18:** Backtest harness `scripts/backtest-mc-uk.ts`: train on UK events ≤ 2024-12, simulate 2025→2026-07 week by week, report achieved order-fill vs predicted p_stockout calibration. Output table goes to the DDS&OP.
**Task 19:** Graduation rule (config flag per SKU in `mrp_buffer_profile`): once MC beats zones on 2 consecutive monthly reviews (fewer false reds, no missed stockouts), the trigger for that SKU switches from `nfp ≤ yellowTop` to `p_stockout > threshold` (core 0.03, slow 0.12) with zones retained as guardrails.

---

## Definition of done

Nightly Slack message of the form *"START MFG: 120× EBH9 — release EBUS PO by 14 Aug. NFP 85 ≤ yellow-top 210. Drivers: 2 open deals (400u @ 35%) + ADU 9.1/wk. Buildable 300 (limit: Akustická pena). Draft PO chain: [approve]"* — where every number is traceable to a table row, the PO chain awaits one click, and the engine has survived a 2-week shadow-run + one DDS&OP without a false-red storm.
