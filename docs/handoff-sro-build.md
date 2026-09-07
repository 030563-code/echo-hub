# Echo Barrier Hub — SRO/PO build (fresh-session handoff)

Open a new Claude Code session **in this repo** (`echo-barrier-hub/`) with the **Obsidian vault** and the **n8n-echobarrier · supabase-echobarrier · xero-chise** MCPs connected, then paste the prompt below.

---

You're continuing the **Echo Barrier Hub** — the SRO / purchase-order / BOM side. Repo: `/Users/deanjeggels/Documents/CH-ISE/Clients/Echo_Barrier/echo-barrier-hub`.

**Read first, in order:**
1. `./CLAUDE.md` — architecture + the per-user capability model + security rules.
2. **Obsidian → `Echo Barrier/Stocks Prediction Module/EchoHub — SRO Build State (June 2026).md`** — the live state, the PO flow, the meeting's SRO requirements, the PDF reference data (product codes, suppliers, Bamida PO format), the remaining slices, and the build discipline. **This is your main context.**
3. Auto-memory `project_hub_build.md` — full build history + decisions.
4. Obsidian also: `Multi-Tier Purchase Order & BOM Workflow.md`, `Intercompany PO System - Dave Checklist.md`, `Cargo Partner API.md`. Meeting transcript: https://notes.granola.ai/t/f06a9b62-f85f-4b9c-98ed-0474ff043455

**Where it stands (summary — full detail in the Obsidian note):**
- Live at **hub.echobarrier.com**; repo `030563-code/echo-hub` is PUBLIC, push via the **deancorserv** gh account; secrets in Netlify/`.env.local` only.
- Built: capability RBAC; Quotes; **3-tier PO** (Depot → Group → SRO, each approval → n8n → Xero); **BOM explosion** of approved SRO POs from the mfg snapshot; **master-price edit** (`bom.edit` + audit log); **Bamida supplier PO + PDF** (`src/lib/bamida-po.ts`, `bom/bamida-po-modal.tsx` — built last session, localhost, **uncommitted**). Transport (Cargo Partner lookup); MRP.
- Data: ops `korylyniwsqtsvzuzydg` (`purchase_orders`/`_lines`, `po_product_catalog`); mfg `cdkpczinzhykcdbfoobn` (`bom_weekly_snapshot`).

**Remaining SRO slices (ranked — see the Obsidian note for detail):**
1. Seed real **catalog + suppliers** from the PDFs (`po_product_catalog` + a suppliers table) → picklists.
2. **Three PO types** — BOM · Pricing (workers must NOT see price) · Transport — `po_type` + a price-visibility capability.
3. **Partial-delivery** batch tracking · **templates/autofill** · **OO1/OO1-1/OO1-2** numbering.
4. **Attachments** per PO · **commercial invoice** · **USD 3-mo-avg** quarterly · **stock-alert** (flag, don't block).
5. **Cargo Partner SPOT-ID auto-retrieve** by general-reference (PO number) — kills Dave's manual entry.
6. Check if **Unleashed has an API** for PO numbers / product refs.

**Before building:** investigate the relevant existing pieces via the MCPs (n8n PO Phase 1/2 + the Hub's three-tier flow, the `purchase_orders`/`po_product_catalog` schema, Xero PO capability across the 4 entities, the mfg BOM tables). The SRO scope is broad — **pick a slice, come back with a short plan + decisions, and confirm before scaffolding.** Don't build the whole list blind.

**Discipline (carry over):** shared prod DB — keep migrations **additive**, never break the live n8n PO Phase 1/2 or the snapshot pipelines. RLS + capability-gate every server action; service_role server-side only; never commit secrets (repo is public). **Localhost only unless told to deploy** — no push without the go-ahead. Confirm the Bamida-PO config (pack size, packaging prices, MAN/PRINT codes) with Yuri/Bamida before it leaves localhost.

**Use:** `frontend-design` + `ui-ux-pro-max` (UI), `supabase-postgres-best-practices` (schema/RLS), `writing-plans`/Plan agent; MCPs `n8n-echobarrier`, `supabase-echobarrier`, `xero-chise`.

**Start by reading `CLAUDE.md` + the Obsidian SRO Build State note, then ask which slice to build — don't scaffold until confirmed.**
