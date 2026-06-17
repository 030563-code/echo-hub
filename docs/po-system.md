# Echo Barrier Hub — Purchase Order system (build notes + activation)

Built 2026-06-15. The Hub now owns the **front** of the intercompany PO lifecycle —
a branch raises a PO, EB Group approves it, and it flows to EB SRO — saved in the Hub
as the record of truth. The downstream stays in n8n.

## What it does (the boundary)

```
Branch (US / Canada) raises a PO in the Hub
   → status 'requested'  (source='hub', leg=DEPOT_TO_EB_GROUP)
   → EB-Group approver Approves (admin-gated)
       → parent → 'approved'
       → Hub RAISES + APPROVES the EB_GROUP_TO_SRO child ('approved')   ← the EB Group → SRO PO, saved in the Hub (no n8n needed)
       → Hub POSTs the n8n handoff webhook (credentialed side-effects only)
           → n8n creates + authorises the EB-Group Xero PO, writes its id back,
             emails EB SRO, posts a Slack notice
   → (or Reject → 'rejected', no SRO leg)
```

The **BOM explosion / sub-PO-in-SRO** phase is deliberately NOT built (future work).

## The 5 decisions (locked with Dean, 2026-06-15)

1. **Coexistence:** Hub owns the front; n8n keeps the back. Hub-raised rows are marked
   `source='hub'`; n8n's hourly Phase 1 keeps producing `source='n8n'` rows and is
   untouched. Phase 2 is dormant (0 executions ever), so there's no live downstream to
   disturb. Retire/pause Phase 1's Xero poll per-depot as each goes live in the Hub.
2. **Capability model:** `po.create` (depot-scoped raiser) + `po.approve` (admin-tier
   EB-Group approver). New `requested_by_uid` / `approved_by_uid` columns carry the real
   identity; the free-text `requested_by`/`approved_by` (n8n's labels) are left alone.
3. **Approval:** the Hub approval queue replaces Phase 1's first Slack gate; a non-blocking
   Slack notice is posted (via n8n). Phase 2's SRO Slack decision is untouched.
4. **Xero:** routed through n8n (Dean's steer) — the Hub holds **no** Xero credentials.
   (`xero-chise` MCP has no PO tools anyway, and the repo is public.)
5. **PO numbering:** the existing DB `generate_po_number()` trigger mints `PO-NNNNN`
   sequentially (preserves Cargo Partner's `general_reference` lookup). No Unleashed.

Branch scope for v1: **US + Canada only**.

## What was built

**DB migration** `supabase/migrations/20260615000000_hub_po_write_flow.sql` (applied to prod
`korylyniwsqtsvzuzydg`, additive):
- `purchase_orders`: `+ requested_by_uid, approved_by_uid (FK auth.users)`, `+ delivery_address`,
  `+ source ('hub'|'n8n', default 'n8n')`.
- `purchase_order_lines`: `+ hs_code, unit_price`.
- Capability-gated write RLS (the existing read-all + service_role policies untouched):
  - `hub: raise PO` — `po.create` + own-depot, INSERT a `requested` hub DEPOT_TO_EB_GROUP row.
  - `hub: approve PO` — `po.approve`, UPDATE pinned to requested→approved/rejected on hub rows.
  - `hub: add PO lines` — `po.create`, lines on your own still-`requested` hub PO.
- Picklist tables (read-all authenticated, service-role managed): `po_product_catalog`
  (seeded 14 NA SKUs), `po_delivery_addresses` (seeded 5 entities, **placeholder addresses**),
  `po_hs_codes` (**empty** — supply the real customs codes).

**Server actions** `src/app/actions/purchase-orders/`:
- `create-po.ts` → `createPurchaseOrder` (po.create, depot-scoped, SKUs validated against the
  catalogue, written via the session client so RLS is the enforcer).
- `decide-po.ts` → `decidePurchaseOrder` (po.approve, IDOR/state-gated; on approve: marks the
  parent, creates the SRO child via service role, POSTs the n8n webhook best-effort).

**UI** under `src/app/(dashboard)/purchase-orders/`:
- `create/` — the branch raise form (depot, delivery address, line items with SKU/HS-code/qty/price).
- `approvals/` — the EB-Group approval queue (approve / reject-with-reason).
- `page.tsx` — capability-aware "Raise PO" + "Approvals (n)" buttons on the existing board.

**n8n** (the `medes.app.n8n.cloud` instance):
- New **INACTIVE** workflow `Yvt6hmVoqYR1U1jg` — "PO — Hub Approved → EB Group Xero + SRO".
  Webhook `POST https://medes.app.n8n.cloud/webhook/po-hub-approved`. Mirrors Phase 1's
  verified Xero create→authorise→PDF + Gmail-to-SRO + Slack contract, collapses Phase 1's two
  Slack gates + child-row creation (the Hub does those), and adds the Xero-id write-back Phase 1
  lacked. **Phase 1 / Phase 2 were not touched.**

## Verification done

- typecheck ✓ · lint ✓ (0 errors) · `next build` ✓ (both new routes compile) · 23/23 unit tests ✓.
- Live RLS on prod (rolled back): super-admin raise **allowed** (trigger minted `PO-01020`);
  Jillian (quotes-only) raise **blocked** — `42501 row-level security`.

## To go live (Dean)

1. **Grant capabilities** (no admin UI yet → service role): give branch raisers `po.create`
   (+ set their `profiles.allowed_depots`) and EB-Group approvers `po.approve`. Today only the
   two super-admins can use the flow.
2. **Wire the n8n workflow** `Yvt6hmVoqYR1U1jg`: attach the 4 credentials (Xero generic OAuth2
   `Xero Try`; Supabase `Echo Barrier Shipping and Stocks`; Slack `eb shipping stocks`; the Gmail
   sender) to the unset nodes, optionally set the `x-hub-secret` check, review, then **activate**.
   ⚠️ Activating makes it create real **AUTHORISED** POs in the live EB-Group Xero ledger.
3. **Set env** (Netlify + local): `N8N_PO_APPROVED_WEBHOOK_URL=https://medes.app.n8n.cloud/webhook/po-hub-approved`
   (and optionally `N8N_PO_APPROVED_WEBHOOK_SECRET`). Until set, approval still saves the Hub
   record + SRO child row; only the Xero/email/Slack side-effect is skipped (shown as a warning).
4. **Picklists:** populate `po_hs_codes` and replace the placeholder `po_delivery_addresses`.
5. **🔴 P0 — rotate the leaked service_role key** before real external users. It's the
   previously-public key, still in the Hub `.env.local`, and the repo is now public — every RLS
   policy here is moot until it's rotated. Cascades across Hub + sales-hub + ERP + the n8n
   `supabaseApi` credential, so plan the cascade.

## Open questions

- **PO number format** — using `PO-NNNNN` (the existing generator). Tell me if you want entity
  prefixes (e.g. `EBG-`/`SRO-`); it's a one-line change to `generate_po_number()`.
- **`sku → code_grp`** — the n8n workflow maps the Hub SKU to the EB-Group Xero `ItemCode` via
  `product_code_master`. Confirm every v1 NA SKU has a `code_grp` row, or those lines drop from
  the Xero PO.
- **AU / FR** branches, **Unleashed** (absent from all evidence — not integrated), and the
  per-depot Phase-1-poll cutover remain for later.
