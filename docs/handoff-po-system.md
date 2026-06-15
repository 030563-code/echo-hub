# Echo Barrier Hub — PO System build (fresh-session handoff)

Open a new Claude Code session **in this repo** (`echo-barrier-hub/`), make sure the
**Obsidian vault** and the **n8n-echobarrier · supabase-echobarrier · xero-chise**
MCPs are connected, then paste the prompt below.

---

You're building the next phase of the **Echo Barrier Hub**: the **Purchase Order (PO)
system**. You're in its repo: `/Users/deanjeggels/Documents/CH-ISE/Clients/Echo_Barrier/echo-barrier-hub`.

## Where things stand (the Hub is already LIVE)
- **Deployed:** Netlify site `hub-echo.netlify.app` → **https://hub.echobarrier.com** (SSL provisioned, Cloudflare grey-cloud CNAME `hub` → the Netlify site + a TXT ownership record).
- **Repo:** `github.com/030563-code/echo-hub` (Echo Barrier's GitHub account, owner `o30563@echobarrier.com`). ⚠️ **Now PUBLIC** (had to go public to clear a private-repo contributor limit) — so **never commit a secret**, keep `.env*` gitignored, and treat the deferred `service_role` rotation as more urgent. Push with the **`deancorserv`** gh account (the collaborator with write): `gh auth switch --user deancorserv` → push → switch back. (Netlify env vars hold all real keys; `.env.local.example` is empty placeholders only.)
- **Built + E2E-verified:** capability-based RBAC + 5 modules — **Quotes** (full create flow incl. mandatory probability-of-close), **Purchase Orders (read-only viewer today)**, **BOM** (read-only from the mfg project), **Transport** (Cargo Partner general-ref → SPOT-ID lookup), **MRP** (reorder engine). Both DB migrations are live on prod (capability model + deals_registry region scoping). Full history + decisions: auto-memory **`project_hub_build.md`**.

## Read first, in order
1. `./CLAUDE.md` — architecture, the per-user **capability model** (`profiles` / `capabilities` / `user_capabilities` + `has_capability()` RLS), security rules.
2. Auto-memory `project_hub_build.md` — the entire build + every decision so far.
3. Obsidian (vault → `Echo Barrier/`): `Stocks Prediction Module/Multi-Tier Purchase Order & BOM Workflow.md`, `Stocks Prediction Module/Intercompany PO System - Dave Checklist.md`, `Stocks Prediction Module/Cargo Partner API.md`, and this meeting's transcript: https://notes.granola.ai/t/686a42cd-d9f5-4b25-bef1-e9751c9df129
4. The **existing PO infrastructure you're extending** (investigate via MCP — see "Investigate first").

## Meeting outcomes that frame this build (2026-06-15)
- **Hub becomes the central system**, replacing Mondays / Unleashed / Google Sheets over time. It **exports to Xero, HubSpot and Mondays** rather than replacing them immediately — Mondays stays the visual tracker; the Hub becomes the data source feeding it.
- **Order flow vision:** Dash 1 = manufacturing (to Bermuda/Bamida) · Dash 2 = transport (Cargo Partner or L-Trans).
- **Supabase consolidation:** login-based features must eventually live in ONE project (each user — Chelion, Claire, Jillian — sees only their permitted data). **Decision: leave the existing projects as-is for now** (don't break n8n), migrate into a single EchoHub project as features are built.
- **Cargo Partner:** SPOT IDs are entered manually by Dave today. The API supports **lookup by general reference = the PO number** → auto-retrieve the SPOT ID (PO `1364` is visible in a real Cargo Partner record). Unleashed (SRO's current BOM/stock system) generates the PO numbers Cargo Partner already references. Container number is a fallback search key.
- **BOM/prices:** BOM component data (codes, qtys, unit costs) is already in the **mfg Supabase project** (`bom_weekly_snapshot.component_detail`). Yuri/Juraj need a Hub UI to update prices directly (replacing Google Sheets; Supabase gives history sheets don't). Bamida/Bermuda cost splits into unit cost + packing charge (separate line). HS codes + product codes (H9, H10) become Supabase-backed picklists.
- **Invoicing (context, later):** two invoices per shipment — SRO→Group (EUR) and Group→USA (USD, day's FX). Raised by the Slovak accountant on Yuri's instruction from a standard template; invoice number (e.g. `EBGS2026…`) travels with the container.

## THE GOAL OF THIS BUILD — the PO system in the Hub
Today, raising a PO means looking at Xero. We want to **create the PO in the Hub's PO section instead**, run it through approval **on the Hub (admin-gated)**, and flow it through the intercompany chain:

> An **international branch** (US, Canada, Australia, France, …) raises a PO in the Hub → **approval** → **EB Group** → once approved → **sent to the SRO organisation via the Hub + Xero**.

The PO must be **saved in the Hub's system** as the record of truth (with delivery addresses, product fields/picklists, the approval trail). **Stop there for this build.**

**Already half-built in n8n:** the `PO Phase 1` and `PO Phase 2` workflows already do a version of this (Slack approval + Xero PO creation). The job is to bring the **raise + approval** into the Hub UI and reconcile with / take over from those workflows — **without breaking the live ones**.

### FUTURE phase (do NOT build yet — context only)
Once the PO flow works and is saved: when a PO is raised to SRO, it **explodes into its BOM contents** — e.g. `500 × H9` → the BOM is populated from the **manufacturing Supabase project** into a **new sub-PO in SRO**, ready to send to their suppliers. That's the next handoff, not this one.

## Investigate FIRST (use the MCPs — before writing any code)
1. **n8n-echobarrier** — read the existing flow in full so you reuse its contract and don't double-drive it:
   - `PO Phase 1 — Depot to EB Group Approval` (id `CFdCJdixg2PgFpgn`, active) — polls USA/Canada Xero for AUTHORISED POs, first Slack approval, creates a DRAFT PO in EB Group Xero, second Slack review, then authorises + emails SRO + creates the child PO.
   - `PO Phase 2 — SRO Stock vs Manufacture Decision` (id `bAoRdX2DxwMSdNda`, active) — triggered when a PO reaches EB SRO; Slack stock-vs-manufacture decision; Xero SRO PO creation.
   - Use `get_workflow_details` on both; note statuses, the entity legs, Slack approval, and the Xero calls. These write `purchase_orders` as **service_role** (RLS-immune).
2. **supabase-echobarrier** — the system of record is the **ops project `korylyniwsqtsvzuzydg`**:
   - Inspect `purchase_orders` + `purchase_order_lines` (columns incl. `parent_po_id`, `master_ref`, `leg` = `DEPOT_TO_EB_GROUP` / `EB_GROUP_TO_SRO`, `from_entity`/`to_entity`, `status` = requested/approved/rejected/sro_evaluating/fulfilling_from_stock/in_manufacturing/shipped/delivered/cancelled, `fulfilment_type`, `requested_by`/`approved_by`/`decided_by` (free-text today, NOT auth.uid), `slack_*`, `xero_po_id`/`xero_tenant_id`, `po_number`). Check existing rows + the lifecycle.
   - The Hub's PO module currently READS these. RLS on `purchase_orders` is currently read-all-for-authenticated — you'll need capability + entity scoping for a write flow.
3. **xero-chise** — see what's possible for POs across the 4 entities (Group / SRO / USA / Canada): listing, creating, and authorising purchase orders (`list-...`, `create-...`). The Hub should be able to push an approved PO into Xero (the export-to-Xero direction), mirroring what PO Phase 1 does today.

## Decisions to bring back BEFORE building (confirm with Dean — don't scaffold first)
- **Data model + coexistence:** how the Hub's PO create/approve coexists with the live n8n PO Phase 1/2 + the shared `purchase_orders` table (the audit caution: shared prod DB — don't break workflows). Does the Hub become the writer/driver and n8n step back, or does the Hub feed n8n? Reconcile to avoid double-driving the lifecycle.
- **Capability model:** `po.create` (a branch raises), `po.approve` (EB Group approval, admin-gated), and who at each branch/entity gets which. Map `requested_by`/`approved_by` to `auth.uid()` (they're free-text today).
- **Approval on the Hub vs the existing Slack approval** — replace, or complement (Hub approval that still notifies Slack)?
- **Xero export** — Hub creates the Xero PO directly via `xero-chise`, or keeps n8n doing the Xero side after Hub approval?
- **PO numbering** — Unleashed currently generates PO numbers Cargo Partner references; does the Hub generate them or read Unleashed (check if Unleashed has an API)?

## Use these
- Skills: **`frontend-design`** + **`ui-ux-pro-max`** (the PO raise/approval UI), **`supabase-postgres-best-practices`** (schema/RLS), and **`writing-plans`** / the **Plan** agent for the implementation plan.
- MCP: **`n8n-echobarrier`** (existing PO flow), **`supabase-echobarrier`** (purchase_orders + the capability model), **`xero-chise`** (PO export across the 4 entities).

## Security (carry over — non-negotiable)
RLS on every table from day 1; capability-gate every server action server-side (verify capability + ownership; never trust a client id/role); `service_role` server-side only, never committed. **The repo is PUBLIC now** — never commit secrets, and flag if the deferred `service_role` rotation should be brought forward.

## Boundary
Build until: a PO can be **raised in the Hub by a branch → approved (admin) → sent to EB Group → on approval pushed to SRO via the Hub + Xero**, and the whole thing is **saved in the Hub**. **Then stop.** Do NOT build the BOM-explosion / sub-PO phase yet.

**Start by reading the context + investigating the existing PO infra via the three MCPs, then come back with a short plan + the decisions above — don't scaffold until Dean confirms.** (Questions go via WhatsApp between sessions; next sync tomorrow.)
