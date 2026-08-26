# US Customer Invoicing (accepted quotes, TaxJar, Xero)

Accepted US quotes (depots US-BAL, US-SBD) are reviewed and invoiced inside the Hub
instead of becoming draft Xero quotes. TaxJar calculates the sales tax; the only thing
that lands in Xero is the final AUTHORISED invoice. Canada (CA-HAM) keeps the old
quote-to-Xero path unchanged.

Note on TaxJar's role: TaxJar never generates an invoice document and never emails a
customer. `POST /v2/taxes` returns tax synchronously and `POST /v2/transactions/orders`
records completed orders for filing. The Hub builds and owns the draft invoice.

## The flow

1. **Acceptance gate** (rep side). Moving a deal to Quotation Accepted with a US depot
   requires: an associated company, a deal probability, and a full US delivery address
   (street, city, state, zip, validated and sanitized in `src/lib/us-address.ts`).
   Captured in the Change Stage dialog, written to `deals_registry` BEFORE the HubSpot
   PATCH. Canada and EU acceptances keep the old depot-only requirement.
2. **Queue** (`/invoicing/accepted`). Derived at read time: `deals_registry` rows at
   stage `1170409275` with a US depot, accepted on or after the cutover date, joined to
   any active `customer_invoices` row. No queue table, so replays and re-acceptances
   cannot duplicate anything. Rows appear a minute or two after acceptance (they arrive
   via the n8n HubSpot sync).
3. **Draft build** (`openInvoiceForDeal`). Snapshots the deal's `line_items_raw`:
   fitting kits split into HKNA hooks (carrying the kit price) plus 2x BUNNA bungees
   (at 0.00), pinned to Baltimore; LTLNA lines become TaxJar `shipping`; everything else
   maps 1:1 shipping from the deal depot. Xero item codes re-resolved per line against
   `product_depot_mapping` for that line's own ship-from depot.
4. **Editor** (`/invoicing/[dealId]`). The union of Xero's invoice fields and TaxJar's
   inputs, all editable: dates, customer PO (becomes the Xero Reference), Xero account
   number (doubles as the TaxJar customer id), delivery address, and per line: item
   code, description, qty, unit price, discount, account code, ship-from depot, tax
   (editable after calculation as a flagged manual override).
5. **Send to TaxJar** (`calculateInvoiceTax`). One `/v2/taxes` call per ship-from depot
   group (TaxJar takes a single from-address per call), each carrying its own shipping
   total and the customer id (so reseller exemptions Dave maintains in TaxJar apply).
   Per-line tax mapped back from the breakdown; all-or-nothing persistence; any
   reconciliation gap beyond a cent is surfaced as a warning.
6. **Send to Xero** (`sendInvoiceToXero`). Compare-and-set to `authorizing`, then the
   n8n webhook `/hub-invoice-authorize` (secret header) creates the AUTHORISED ACCREC
   invoice in the US tenant and optionally emails it via Xero. Xero mints the invoice
   number. The HubSpot deal id and quote ref ride on the Xero `Url` field and a history
   note, never on the customer PDF. n8n writes the Xero ids back to `customer_invoices`
   itself, so a retry after a timeout can never double-create.
7. **Filing**. After authorization the order is recorded into TaxJar
   (`transaction_id` = the Xero invoice number, one order per depot group), best-effort
   with a retry button. Status becomes `completed`.

## Status machine

draft -> tax_calculated -> authorizing -> authorized -> sent -> completed, plus voided
(frees the one-active-invoice-per-deal slot). Any tax-relevant edit drops
tax_calculated back to draft and clears tax (`lines_hash` decides; edits to
descriptions and dates are free). Everything at authorized and beyond is terminal in
the Hub: corrections happen in Xero as credit notes.

## Pieces

- Supabase (ops, applied live): `customer_invoices`, `customer_invoice_lines`,
  `customer_invoice_events` (service-role only, RLS on, no policies), RPCs
  `create_customer_invoice` and `save_customer_invoice`, delivery columns on
  `deals_registry`, capabilities `invoicing.view` / `invoicing.manage`.
- Hub: `/invoicing` module, actions in `src/app/actions/invoicing/`, pure logic in
  `src/lib/customer-invoice/` and `src/lib/us-address.ts`, TaxJar client in
  `src/lib/taxjar.ts`.
- n8n: workflow "Hub US Invoicing (TaxJar -> Xero)", id `FL7DfDbwYfKU5rDG`, PUBLISHED,
  with webhooks `/hub-quote-accepted-notify` (Slack notification to the USA team
  channel, verified live) and `/hub-invoice-authorize` (Xero leg). The authorize leg is
  double-gated: the "Check Secret" If node currently holds a PLACEHOLDER (everything
  gets 401, fail-closed) and the "Xero Enabled?" If node is hard-wired false. At G4:
  paste `N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET` from `.env.local` into the Check Secret
  node's right-hand value, verify against the Xero Demo tenant, then flip
  "Xero Enabled?" (see the sticky note on the canvas). The repo's
  `N8N_ECHOBARRIER_API_KEY` expired in Nov 2025 (API returns 401); mint a new one in
  the n8n UI if REST access is needed.
- Cutover: `supabase/migrations/pending/20260828000000_us_accepted_quotes_cutover.sql`
  (NOT applied; rollback file alongside in `rollback/`).

## Environment

| Var | Where | Notes |
|---|---|---|
| `TAXJAR_SANDBOX_TOKEN` | local + Netlify | sandbox token, used until go-live |
| `TAXJAR_API_TOKEN` | Netlify at go-live | production token, takes precedence |
| `TAXJAR_API_BASE` | Netlify at go-live | `https://api.taxjar.com` |
| `N8N_CUSTOMER_INVOICE_WEBHOOK_URL` | local + Netlify | `/webhook/hub-invoice-authorize` |
| `N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET` | local + Netlify | matches the n8n workflow check |

Never add these to `SECRETS_SCAN_OMIT_KEYS`.

## Rollout gates (in order)

1. G1 Dean: draft builder output eyeballed against 2 or 3 real accepted US deals (one
   with a fitting kit, one with LTLNA shipping).
2. G2 Dave: queue and editor walkthrough on live accepted deals, pre-cutover, no sends.
3. G3 Dave: sandbox tax calc on a real accepted quote; stored request/response reviewed.
   (Sandbox validates formats, NOT rates: do not judge the dollar amounts.)
4. G4 Dean + Dave: n8n leg verified against a Xero DEMO tenant. Confirm the per-line
   TaxAmount representation (fallback: single sales-tax summary line), the minted
   InvoiceNumber format, Reference = PO, the Url and history note staying off the
   customer PDF, and the email template. Flip `xeroEnabled` and swap in the real tenant
   only after this.
5. G5: apply the cutover migration (US stops producing draft Xero quotes; Slack
   notification takes over), production TaxJar token in, first real invoice supervised.

## Known limits and defaults

- US-SBD dispatch address is not configured yet (blank in `po_delivery_addresses` too):
  tax calculation refuses San Bernardino groups until Dean supplies it in
  `src/lib/customer-invoice/constants.ts`.
- Kit price allocation default: hooks carry the kit unit price, bungees are 0.00.
  Revenue-neutral, editable per line, but per-item revenue reporting in Xero skews
  toward hooks. Dave should confirm he is happy with that.
- Deals accepted directly inside HubSpot bypass the acceptance gate; the queue shows
  them as "Missing address" and the reviewer completes the address in the editor.
- TaxJar sandbox: address validation unavailable, transactions stubbed, rates
  approximate. Real rates, real exemptions and the email leg can only be verified at
  go-live.
- Dave's TaxJar account setup (his action item): nexus state settings, and customers
  with `customer_id` = the Xero account number plus `exemption_type` wholesale for
  resellers with certificates.
