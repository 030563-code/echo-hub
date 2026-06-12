# Echo Barrier Hub — fresh-session handover prompt

Open a new Claude Code session **in this folder** (`echo-barrier-hub/`), make sure the **Obsidian vault** is in context, and paste the prompt below.

---

You're building the **Echo Barrier Hub**. You're in its repo: `/Users/deanjeggels/Documents/CH-ISE/Clients/Echo_Barrier/echo-barrier-hub`.

**Read first, in order:**
1. `./CLAUDE.md` — architecture, the per-user access model, the apps to connect, the data layer, and the security rules. Read it fully.
2. Obsidian context (vault → `Echo Barrier/`):
   - `Echo Barrier Hub — Vision & Build Plan.md` — the vision + the 2026-06-12 meeting decisions
   - `CORTEX/CORTEX — Project Overview.md` — the data layer + how the AI org consumes the Hub
   - `Stocks Prediction Module/` + `Stocks Prediction Module/Cargo Partner API.md` — the MRP engine the probability-of-close feeds, and the shipping lookup
3. The two apps you're merging: `../echo-barrier-sales-hub` (Quotes — Priority 1) and `../echo-barrier-erp-platform` (ERP). Skim their `(dashboard)` routes, Supabase client setup, and server actions so you port patterns, not reinvent them.

**Goal:** a unified Next.js + Supabase app — single login, per-user capability-based access — merging Quotes + ERP into one shell with a page per workstream (Quotes · Purchase Orders · BOM · Transport · Weeklies). **First deliverable: the Quotes module live for Jillian (US), built around the mandatory "probability of close" field** (the backbone that feeds stock/manufacturing/forecasting).

**Use these:** the `frontend-design` and `ui-ux-pro-max` skills for the UI; `supabase-postgres-best-practices` for schema/RLS. The `supabase-echobarrier` MCP for the two projects (ops `korylyniwsqtsvzuzydg`, mfg `cdkpczinzhykcdbfoobn`) and `n8n-echobarrier` for Dave's stock + outstanding-quotes workflows.

**Before writing any code, come back to me with a short plan + these decisions:**
- **Decision 1:** build the Hub *fresh* here and port both apps in, **or** grow `echo-barrier-sales-hub` into the Hub (it's already the quotes flow on the newest stack — faster to Jillian). Give your recommendation.
- The auth + **per-user capability** model (`profiles` / `capabilities` / `user_capabilities` + RLS). e.g. Jillian = `quotes.view`+`quotes.create`+`po.create`, not `po.approve`.
- The phase order below.

**Phases (confirm each before starting):**
1. **Shell + auth + RBAC** — Next.js (App Router 16) + TS + Tailwind 4 + Radix/shadcn + Supabase Auth; per-user capability model; nav gated by capability; RLS on from day 1.
2. **Quotes module** — port the quote-create flow from `echo-barrier-sales-hub`, with the mandatory **probability-of-close** field, wired to Supabase `deals_registry`. Make it Jillian-ready.
3. **ERP modules** — Transport (port ERP `/shipping` + the Cargo Partner general-reference→SPOT-ID lookup), Purchase Orders, BOM, MRP.
4. **Weeklies** tracker (Mondays/Tuesdays/Wednesdays).
5. **Security pass + deploy** — RLS everywhere, service_role server-side only, no IDOR → Netlify at `quotes.echobarrier.com`.

**Security is non-negotiable:** the previous sales-hub leaked its service_role key in a public repo and shipped permissive RLS with IDOR. RLS on every table from day 1; anon/publishable key client-side; service_role server-side only, never committed; authorize every action server-side.

Use dummy stock figures (with an override path) where manufacturing stock is still unknown. Start by reading the context, then return with the plan + Decision 1 — **don't scaffold until I confirm.**
