# Echo Barrier Hub — project context (CLAUDE.md)

## What this is
The **Echo Barrier Hub** is the unified internal operating platform for Echo Barrier — **one app, single login per user, per-user role-based access**, with a **page per workstream**. It merges the existing standalone builds (Quotes + ERP + the weekly tracker) into one shell behind one auth.

Full vision + decisions: Obsidian → `Echo Barrier/Echo Barrier Hub — Vision & Build Plan.md`.

## The goal of this build
**Connect the existing Quotes and ERP platforms onto this Hub.** First deliverable: the **Quotes module live for Jillian (US)** at `quotes.echobarrier.com`.

## The existing apps to connect (siblings, same parent dir `../`)
| App | Local path | Stack | What it is |
|---|---|---|---|
| **Quotes** (Priority 1) | `../echo-barrier-sales-hub` (pkg `echo-sales-tool`) | Next 16 · React 19 · Supabase · Tailwind 4 · Radix | The quote-creation flow. Routes: `(admin) (auth) (dashboard) sales actions`. GitHub `030563-code/echo-barrier-sales-hub`. |
| **ERP** | `../echo-barrier-erp-platform` | Next 15 · React 19 · Supabase · Tailwind 4 · Radix | `/shipping`, `/mrp`, PO + BOM boards. Routes: `(auth) (dashboard)`. No git remote set locally. |
| **Logistics** | `../echo-barrier-logistics-hub` | React 19 · Supabase | Logistics/shipping app. GitHub `DeanJeggels/echo-barrier-logistics-hub`. Fold into **Transport** later. |

> **First decision (raise with Dean):** build the Hub *fresh* here and port both apps in, **or** grow `echo-barrier-sales-hub` into the Hub (it already has auth + dashboard + the quotes flow on the newest stack) and absorb ERP + weeklies. The latter is faster to Jillian — recommend it unless Dean wants a clean shell.

## Stack (adopt the existing one — clean porting)
Next.js (App Router, 16) · React 19 · TypeScript · Tailwind 4 · Radix / shadcn-style · lucide-react · Supabase.

## Access model — per-user capabilities (NOT generic role types)
- Supabase Auth (single login per user).
- `profiles` (id = auth.users.id, full_name, email, region/country, is_active)
- `capabilities` enum: `quotes.view`, `quotes.create`, `po.view`, `po.create`, `po.approve`, `bom.view`, `transport.view`, `weeklies.view`, `admin`, …
- `user_capabilities` (user_id, capability) — assigned **per user**. UI gates nav + actions by the user's capabilities; **RLS** enforces server-side.
- Example: **Jillian** = `quotes.view` + `quotes.create` + `po.create` (NOT `po.approve`).

## Pages (one per workstream)
`/` dashboard · `/quotes` · `/purchase-orders` · `/bom` · `/transport` · `/weeklies` (Mondays/Tuesdays/Wednesdays tracker).

## The backbone
Every quote requires a **"probability of close"** field. It feeds **stock availability, manufacturing need, and order forecasting** (the MRP engine — Obsidian `Stocks Prediction Module/`). This is the fundamental mechanism — build the Quotes module around it.

## Data (Supabase — via the `supabase-echobarrier` MCP)
- **ops** `korylyniwsqtsvzuzydg` — deals_registry, invoices_registry, account_registry, purchase_orders/_lines, shipment_contents/shipments/shipment_events, warehouse_stock_levels, product_code_master.
- **mfg** `cdkpczinzhykcdbfoobn` — bom_weekly_snapshot, landed_weekly_snapshot, fx_weekly, invoice_markup_config.
- Stock is blocked (manufacturing levels unknown) → use **dummy figures with an override path** until the manufacturer stocktake lands.
- n8n (Dave's stock + outstanding-quotes workflows): `n8n-echobarrier` MCP.

## Security (NON-NEGOTIABLE — learn from the sales-hub audit)
The previous sales-hub leaked its **service_role key in a public repo**, shipped **permissive RLS**, and had **IDOR + depot self-escalation**. Do not repeat:
- **RLS on every table from day 1.** Anon/publishable key client-side only; **service_role server-side only**, never in the repo.
- **Authorize server-side** on every action (verify capability + ownership; never trust a client-supplied id/role).

## Skills + MCP to use
- Skills: **`frontend-design`** + **`ui-ux-pro-max`** (UI), **`supabase-postgres-best-practices`** (schema/RLS).
- MCP: **`supabase-echobarrier`** (both projects), **`n8n-echobarrier`** (workflows).

## Deploy
Netlify → `quotes.echobarrier.com` (Cloudflare DNS, grey-cloud CNAME). Do the security pass **before** any real user. See Obsidian `Echo Barrier/CORTEX/Dean's Runbook — Technical Steps.md` §C–D.
