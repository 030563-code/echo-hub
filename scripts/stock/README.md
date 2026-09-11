# Stock warm-start loaders

Three scripts that load the figures Juraj sends into the stock ledger. Each one
is a dry run by default and writes nothing until `--apply` is given. Each run
mints one batch id, so re-running the same file with `--apply` applies nothing
twice.

```
npx tsx --env-file=.env.local scripts/stock/load-finished-count.ts --file counts-finished.csv --warehouse EB-SRO --counted-by "Juraj"
npx tsx --env-file=.env.local scripts/stock/load-material-count.ts --file counts-materials.csv --warehouse EB-SRO --counted-by "Juraj"
npx tsx --env-file=.env.local scripts/stock/load-in-flight-orders.ts --file in-flight-orders.csv
```

Add `--apply` to record. Templates (headers only) are in `templates/`.

## Order of loading

1. Switch off the old n8n "PO Phase 1" Xero poll, so it cannot insert its own
   rows beside the loaded chains.
2. In-flight orders.
3. Finished-goods count.
4. Materials count.
5. Open `/stock/finished` and check EB-SRO on hand, committed and in production.

## CSV shapes

`counts-finished.csv`: `sku,quantity,product_name` (product name optional).
Whole units. SKUs are the order-line codes (EBH9NA), not the SK codes.

`counts-materials.csv`: `component_code,quantity,unit,description`. Codes must
exist in the supplied-components recipe (`mrp_bom_map`) and cannot be a charge
line. Fractions are fine (metres of roll).

`in-flight-orders.csv`: one row per order line; rows sharing `chain_key` make
one order. `stage` is one of `sent`, `in_production`, `finished`, `ready_stock`.
Real Xero and Bamida PO numbers matter, because Cargo Partner auto-detect keys
on the PO number; a blank number lets the Hub mint one.
