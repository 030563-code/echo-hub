# Stock warm-start loaders

Four scripts that load the figures Juraj sends into the stock ledger. Each one
is a dry run by default and writes nothing until `--apply` is given. The three
count and order loaders mint one batch id per run, so re-running the same file
with `--apply` applies nothing twice; the material-orders loader inserts plain
rows, so run it once per sheet.

```
npx tsx --env-file=.env.local scripts/stock/load-finished-count.ts --file counts-finished.csv --warehouse EB-SRO --counted-by "Juraj"
npx tsx --env-file=.env.local scripts/stock/load-material-count.ts --file counts-materials.csv --warehouse EB-SRO --counted-by "Juraj"
npx tsx --env-file=.env.local scripts/stock/load-in-flight-orders.ts --file in-flight-orders.csv
npx tsx --env-file=.env.local scripts/stock/load-material-orders.ts --file material-orders.csv --warehouse EB-SRO
```

Add `--apply` to record. Templates (headers only) are in `templates/`.

## Order of loading

1. Switch off the old n8n "PO Phase 1" Xero poll, so it cannot insert its own
   rows beside the loaded chains.
2. In-flight orders.
3. Finished-goods count.
4. Materials count.
5. Materials on order (the "ordered not delivered" column of the sheet).
6. Open `/stock/finished` and check EB-SRO on hand, committed and in production;
   `/stock/materials` for on hand, committed and on order.

## CSV shapes

`counts-finished.csv`: `sku,quantity,product_name` (product name optional).
Whole units. SKUs are the order-line codes (EBH9NA), not the SK codes.

`counts-materials.csv`: `component_code,quantity,unit,description`. Codes must
exist in the supplied-components recipe (`mrp_bom_map`) and cannot be a charge
line. Fractions are fine (metres of roll).

`in-flight-orders.csv`: one row per order line; rows sharing `chain_key` make
one order. `stage` is one of `sent`, `in_production`, `finished`, `ready_stock`.
Real Xero and Bamida PO numbers matter, because Cargo Partner auto-detect keys
on the PO number. A blank number is refused rather than minted: since the
14 Sep 2026 numbering scheme a blank would spend a live EBUSA or EBGRP number,
one Xero is about to put on a new order, on an order raised months ago. The
loader checks every chain in the file before it writes any of them, so a blank
found late does not leave half the file loaded. A blank `depot` means an order
that refills the s.r.o. shelf (the UK H9 refills): no depot leg, the SRO order
is the root of its own chain, and its lines are never shown as committed.
`EB-SRO` in `depot` needs `depot_po_number` filled with that order's real Xero
purchase order number; `EB-SRO` has no number series of its own, so if that
order never had a number, leave `depot` blank and the chain loads as a refill.
A real depot (`US-BAL`, `US-SBD`, `CA-HAM`) is different: keep the depot and put
a number in. Blanking the depot to get past the refusal loses the depot leg, and
with it the depot's inbound figure, the committed figure, and anything to
receive the goods against when they land.
The only number that may be blank is `bamida_po_number` on a `ready_stock` row,
which has no Bamida order at all. A cell holding only spaces, quoted or not,
counts as blank.

`material-orders.csv`: `component_code,quantity,unit,expected_at,supplier,note`.
Codes as for the materials count. `expected_at` is `YYYY-MM-DD` or blank.
