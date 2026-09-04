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
   stage `1170409275` with a US depot, whose acceptance (dated from
   `deal_stage_history`, NOT from `deals_registry.updated_at`, which does not move when
   an acceptance syncs in and runs days to months stale) is on or after the cutover
   date, joined to any active `customer_invoices` row. No queue table, so replays and re-acceptances
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
   (editable after calculation as a flagged manual override). Plus the
   **Collected by the customer (Will Call)** toggle: see the Collection section below.
5. **Send to TaxJar** (`calculateInvoiceTax`). One `/v2/taxes` call per ship-from depot
   group (TaxJar takes a single from-address per call), each carrying its own shipping
   total and the customer id (so reseller exemptions Dave maintains in TaxJar apply).
   The destination is the invoice's delivery address, or, on a collected order, each
   group's own depot address. Per-line tax mapped back from the breakdown;
   all-or-nothing persistence; any reconciliation gap beyond a cent is surfaced as a
   warning.
6. **Send to Xero** (`sendInvoiceToXero`). Compare-and-set to `authorizing`, then the
   n8n webhook `/hub-invoice-authorize` (secret header) creates a **DRAFT** ACCREC
   invoice in the US tenant. **The Hub mints the invoice number**, not Xero: it is
   passed explicitly as `invoice_number`, because Xero assigns one from its own live
   sequence to anything posted without it and burns that number even if the invoice is
   later deleted. **Nothing is emailed.** Xero is the book of record only; the
   customer-facing invoice is a PDF from the Hub (Dean, 2026-09-03). The HubSpot deal
   id and quote ref ride on the Xero `Url` field and a history note. n8n writes the
   Xero ids back to `customer_invoices` itself, so a retry after a timeout can never
   double-create.
7. **Filing**. After authorization the order is recorded into TaxJar
   (`transaction_id` = the Xero invoice number, one order per depot group), best-effort
   with a retry button. Status becomes `completed`.

## Invoice numbering

The app owns the customer-facing number, `EBUS26-0001`, restarting at
`EBUS27-0001` on 1 January. Credit notes get their own counter, `CNUS26-0001`.

Three properties, each for a stated reason:

- **The app tells Xero the number.** Xero assigns one from its own live sequence
  to anything posted without it, and that number is burned even if the invoice is
  later deleted (a test draft consumed EB1993 that way).
- **Gapless**, so a counter row in `invoice_number_counters` incremented inside the
  raising transaction, never a Postgres sequence. `nextval()` does not roll back, so
  every failed raise would leak a number out of a customer-facing series. Proven
  live: an inner transaction that allocated `EBUS26-0003` and then failed left
  `next_value` at 3, not 4.
- **Allocated at raise, not at draft**, or every abandoned draft burns one. A draft
  carries a holding reference (`USI2026-00005`) where gaps are harmless.

`raise_customer_invoice` is idempotent: an invoice that already has a number gets
that number back rather than a second one, so a retry after a timeout cannot double-
allocate. TaxJar transactions are filed under our number too (`EBUS26-0001-US-BAL`
per depot), so a return traces straight back to the customer document.

The Xero invoice is created as a **DRAFT** carrying our number. The Hub renders and
sends the document, and only then is Xero flipped to AUTHORISED, so the ledger never
carries an invoice that has not gone out.

## Zip-driven address completion

`GET /v2/rates/{zip}` is the only TaxJar call that needs nothing but a zip, and it
returns the state, city, county and combined rate. `POST /v2/taxes` will not accept a
US request without BOTH `to_zip` and `to_state`, so a zip alone can never price an
invoice, but it can complete an address. Both the rep's acceptance dialog and Dave's
invoice editor call `lookupZipJurisdiction` on zip blur: it fills whatever is blank and
never overwrites what a human typed, because a zip can straddle tax districts and their
street-level knowledge wins.

It also catches the mismatch class that a database constraint cannot. TaxJar itself
rejects a wrong pair outright, `to_zip 90404 is not used within to_state TX`, so no
ZIP-to-state lookup table is needed in the app.

The `/invoicing/tax-setup` tab shows both dispatch addresses and the live nexus states,
and flags any state that is registered but not collecting.

## Collection (Will Call)

A collected order is taxed where the customer picks the goods up, not where they live.
`customer_invoices.is_collection` is a header flag Dave sets in the editor; when it is
on, each depot group's TaxJar destination becomes that group's own dispatch address, so
origin and destination are the same place. It falls straight out of the existing
per-depot grouping.

Three things make this safe rather than merely present:

- **The flag is inside `lines_hash`.** Ticking it after a calculation invalidates the
  tax and drops the invoice back to draft. Without that, Dave could calculate delivered
  tax, tick Will Call, and send California tax to Xero while the order was filed to
  TaxJar as Maryland. That needs no race and no crafted input, just a checkbox.
- **The filing uses the same destination as the calculation**, per depot, not per
  invoice. `buildFilingOrders` and `buildTaxRequests` live side by side in
  `tax-mapping.ts` and `tests/unit/taxjar-filing.test.ts` asserts their `to_*` fields
  are equal for the same fixture, delivered and collected, including across two depots.
- **A fresh draft takes the answer from the deal.** `deals_registry.is_collection` is
  set by the rep at Quote Setup and confirmed at Quotation Accepted, and
  `openInvoiceForDeal` seeds the draft from it. Before that column existed every
  invoice opened from the queue started delivered, so a collected order was only
  corrected at review, after the tax had been calculated against the wrong place.
- **A rebuild still carries its own flag forward.** `rebuildInvoiceFromDeal` voids and
  re-opens, passing `isCollection` explicitly, and that explicit value WINS over the
  deal's: it is what the reviewer decided on the invoice being replaced, which is later
  information than the quote's.

The RPC coalesces an absent `is_collection` key onto the STORED value, never onto
false, and `save-draft.ts` requires the field rather than defaulting it, so a stale
browser tab is rejected instead of silently changing the jurisdiction. Flipping it
writes a `collection_changed` event.

Measured in the sandbox on one order (5 x H9 at 185 plus 250 freight): delivered to
Santa Monica CA returned 10.75% and 99.44 of tax; collected from Jessup MD returned 6%
and 55.50. Same lines, 43.94 apart.

Freight on a collected order is kept in the tax base and warned about rather than
dropped, because Xero bills that freight either way.

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
  channel, verified live) and `/hub-invoice-authorize` (Xero leg).

  **BOTH GATES ARE NOW OPEN. The Xero leg is live and armed against the production
  Echo Barrier USA tenant `4a845dad-c15a-4f6d-a417-c4286e02b3ea`.** Re-verified
  read-only on 2026-09-03 against the PUBLISHED version `c6122630`: "Check Secret"
  holds the real 48-character secret, not a placeholder, so a correctly signed request
  is accepted; and "Xero Enabled?" evaluates `"enabled" equals "enabled"`, which is
  always true. This paragraph previously said the opposite, that everything got a 401
  and the Xero gate was hard-wired false. Anyone trusting that would have believed a
  test request was safe when it posts to the live ledger.

  The "Email Invoice" node (id `d5b3d232-23dd-446c-a8f5-e99a3f2b766e`, POST
  `/Invoices/{id}/Email`) is also still ENABLED behind the "Email Requested?" If node.
  It is unreachable from the Hub, which hardcodes `email_to_customer: false`, but it is
  dormant rather than removed and still needs disabling at source. Note that the
  workflow carries an unpublished draft (`sameAsDraft: false`), so an edit does not
  take effect until it is published, and publishing also ships that pending draft.

  The repo's
  `N8N_ECHOBARRIER_API_KEY` expired in Nov 2025 (API returns 401); mint a new one in
  the n8n UI if REST access is needed.
- Cutover: `supabase/migrations/pending/20260828000000_us_accepted_quotes_cutover.sql`
  (NOT applied; rollback file alongside in `rollback/`).

## Environment

| Var | Where | Notes |
|---|---|---|
| `TAXJAR_SANDBOX_TOKEN` | local + Netlify | sandbox token, used until go-live |
| `TAXJAR_API_TOKEN` | Netlify at go-live | production token, takes precedence |
| `TAXJAR_API_BASE` | leave UNSET | override only, see below |
| `N8N_CUSTOMER_INVOICE_WEBHOOK_URL` | local + Netlify | `/webhook/hub-invoice-authorize` |
| `N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET` | local + Netlify | matches the n8n workflow check |

Never add these to `SECRETS_SCAN_OMIT_KEYS`.

**Go-live is setting `TAXJAR_API_TOKEN` and nothing else.** The presence of that
token is the switch: `config()` in `src/lib/taxjar.ts` then defaults the host to
`PRODUCTION_BASE`, which is already `https://api.taxjar.com`. Setting
`TAXJAR_API_BASE` as well is at best redundant and at worst breaks the whole
integration, because `taxjarFetch` builds every URL as `base + path` and every
path already starts with `/v2`. A base of `https://api.taxjar.com/v2`, which is
the natural thing to paste from TaxJar's own docs, produces `/v2/v2/taxes` and
404s on every call. Leave it blank.

## Testing note: the queue starts empty on purpose

`INVOICING_QUEUE_SINCE` in `src/lib/customer-invoice/constants.ts` is the cutover date,
so until someone accepts a US deal after it the queue is legitimately empty. To dry-run
G1/G2 against real data, temporarily set that constant to `'2026-08-19'` (the date
`deal_stage_history` started recording), which surfaces the 7 genuine recent US
acceptances, and put it back before the cutover.

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

## Hardening applied after the adversarial review (2026-08-26)

- Tax is applied through `apply_customer_invoice_tax`, one transaction guarded on
  status AND on the hash the calculation ran against, matching lines by `line_key`.
  The previous per-line update loop keyed on row uuids read before the TaxJar calls,
  so a save landing mid-calculation (which replaces the rows) silently wrote nothing.
- Freight-only depot groups are folded into a group that carries goods: TaxJar rejects
  a request with empty `line_items` and no `amount`.
- The TaxJar order `amount` is summed from the exact figures sent as line items
  (quantity x unit_price minus the dollar discount), which is how TaxJar itself sums
  them; deriving it from our rounded `line_total` could differ by a cent and be
  rejected. Verified against the sandbox with a discounted two-line order.
- Discounted shipping lines now carry `discount_rate` into the Xero payload; without it
  Xero billed the undiscounted freight while the stored total and tax base used the
  discounted one.
- `openInvoiceForDeal` enforces the same two filters as the queue (deal must be at the
  accepted stage, and accepted on or after the cutover date), so navigating straight to
  `/invoicing/<dealId>` cannot invoice a deal still in negotiation or re-invoice a
  pre-cutover deal.
- Kit lines are pinned to Baltimore from the STORED line's origin, not the client's.
- A Send-to-Xero TIMEOUT no longer releases the invoice back to `tax_calculated`
  (that allowed a second Send to race an in-flight n8n run and double-create in Xero).
  It stays locked in `authorizing`; the 10-minute reset control, which re-checks that
  no Xero ids landed as part of its compare-and-set, is the only way out.
- Send to Xero saves first, so on-screen edits can never be excluded from the invoice
  that is sent; if the edits change the tax base the send stops and asks for a recalc.
- The editor remounts on every server change (keyed on the row's updated_at), so it
  cannot display stale lines or a stale status after a save, calc, send or rebuild.
- `TAXJAR_API_TOKEN` is required for the production endpoint: the sandbox token is
  never a silent fallback, because sandbox rates are plausible but wrong.
- The queue's Open button no longer calls a manage-gated action for view-only users.

## Known limits and defaults

- Both dispatch addresses are configured: US-BAL 8125 Stayton Drive, Jessup MD 20794
  and US-SBD 9119 Milliken Ave, Rancho Cucamonga CA 91730 (from the EBUSA
  order-to-invoice handover, 2026-09-02). Each zip was verified against TaxJar
  `GET /v2/rates/{zip}`, and a live two-depot calculation returns 10.75% delivered to
  Santa Monica, 6% collected at Jessup and 7.75% collected at Rancho Cucamonga.
- **Maryland is registered but switched off in TaxJar**, so a Maryland destination
  returns zero tax with no error. Calculation refuses it: `US_REGISTERED_STATES` in
  `constants.ts` is compared against the LIVE `GET /v2/nexus/regions` list before any
  calculation call. It clears itself when Maryland is switched on, with no deploy.
  This matters most for collections, because US-BAL is in Jessup, Maryland, so every
  order collected at Baltimore is a Maryland sale. Note the flag on the calculation
  response cannot be used for this: the sandbox returns `has_nexus: true` for Maryland
  while the nexus list excludes it.
- **Never bulk-update `account_registry`.** It carries an unconditional AFTER INSERT OR
  UPDATE trigger that POSTs every touched row to the n8n `xero-code` webhook, so
  "cleaning up" its 15,335 empty-string account codes would fire 15,335 account-code
  generations. The empty strings are handled in code instead
  (`open-invoice.ts` coerces blank to null); only 48 of 44,170 rows hold a real code.
- One delivery address per invoice, and one collection flag for the whole invoice. A
  part-collected, part-delivered order is two invoices. Nothing in the database has ever
  recorded a deal delivering to two sites (all `deals_registry.delivery_*` columns were
  NULL on all 2,062 rows before this build), so this is unproven rather than ruled out.
- HubSpot holds no delivery address and no collect-versus-deliver field. Of 573 deal
  properties the only delivery one is `delivery_country`, a country-level enum. The Hub
  acceptance gate is therefore the sole system of record for the ship-to address, and
  for collection. Collection is asked at Quote Setup, confirmed in the acceptance
  dialog (where ticking it hides the address fields, because a collected order has no
  delivery address), and carried on `deals_registry.is_collection`. The invoice
  editor's own checkbox remains the reviewer's override of record.
  That column is written by the two writers that ALREADY existed, `createQuote`'s
  upsert and `updateDealStage`'s acceptance upsert. Do not add a third writer to
  `deals_registry` without reading the trigger notes in the pending guards migration
  first: every row write POSTs to n8n and runs `notify_quote_accepted()`.
- Kit price allocation default: hooks carry the kit unit price, bungees are 0.00.
  Revenue-neutral, editable per line, but per-item revenue reporting in Xero skews
  toward hooks. Dave should confirm he is happy with that.
- Deals accepted directly inside HubSpot bypass the acceptance gate; the queue shows
  them as "Missing address" and the reviewer completes the address in the editor.
- TaxJar sandbox: address validation unavailable, transactions stubbed, rates
  approximate. Real rates, real exemptions and the email leg can only be verified at
  go-live.
- The `/hub-quote-accepted-notify` webhook is unauthenticated and its URL is in this
  public repo, so a stranger could post a fake Slack notification into the team
  channel. Impact is limited to Slack noise (it triggers no Xero or TaxJar work); if
  that becomes annoying, add a Supabase lookup in n8n that drops payloads whose deal id
  is not an accepted US deal.
- Dave's TaxJar account setup (his action item): nexus state settings, and customers
  with `customer_id` = the Xero account number plus `exemption_type` wholesale for
  resellers with certificates.
