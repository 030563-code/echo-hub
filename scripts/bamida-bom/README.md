# Bills of materials from Bamida delivery notes

Bamida send a **dodací list** (delivery note) with every batch. It lists what
the batch consumed, line by line, with quantities and no prices. That is the
only description of how an Echo Barrier product is actually built that we hold,
so it is where the manufacturing bill of materials comes from.

This directory turns a folder of those PDFs into rows in Supabase. It is meant
to be run again: tranche 3 should be a diff against tranche 2, not another
derivation from scratch.

## The model

A delivery note describes one batch. The bill of materials has to answer "what
does one unit need", and the answer is not a single division. Some lines are
drawn once per unit and some once per pallet, and a pallet is a step:

    required(q) = per_unit * q + per_pallet * ceil(q / pallet_size)

Dividing everything by the batch size is wrong for about a third of the lines,
and wrong in the direction that under-orders. Eight packaging lines came out
constant per pallet across every product that has them, which is what makes the
model credible rather than merely fitted:

| code  | material                    | per pallet |
| :---- | :-------------------------- | ---------: |
| 30040 | Vak na balenie (packing bag) |          1 |
| 4898  | TK.PE 753 modrý kašír        |      20 m² |
| 30045 | Kovové zaistenie             |          1 |
| 1781  | Kovové istenie               |          1 |
| 371   | SKR. do dreva žltá 5x50      |         16 |
| 361   | Texa do železa 4,8x25        |          6 |
| 2192  | Nctech nitka 34 čierna       |       50 m |
| 378   | KAROS. PODLOŽKA ZI 5x30      |         10 |

The packing bag is the anchor: exactly one per pallet on every note, so the
pallet count is observable and `pallet_size = batch / pallet_count`.

## Reading a note

Columns are code, description, quantity, unit. Lines numbered `1.` `2.` at the
left margin are top-level items; indented lines beneath belong to the item above.

**A child whose description starts with a literal `- ` is a material. Anything
else is an operation.** Do not use the code to decide this. It is tempting,
because operations often carry zero-padded codes like `000340`, but some carry
plain numeric ones (`356 zváranie strechy` is an operation) and some materials
carry four-digit codes. Quantities are Slovak: `1 120,00` is 1120.0.

## The pipeline

```bash
mkdir -p dl && for f in ~/Downloads/<folder>/*.pdf; do
  pdftotext -layout "$f" "dl/$(basename "${f%.pdf}").txt"
done
# transcribe each note to transcripts/<slug>.json, then:
python3 derive.py       # two-tier rates + pallet ranges -> derived.json
python3 crosscheck.py   # regression, stock join, per-pallet constants, pallet sizes
python3 load.py         # idempotent insert into Supabase
```

`derive.py` refuses to invent a number. Where a note cannot settle a value it
says so and emits nothing: a batch too small to pin the pallet size, packaging
shared between two products on one note, a note supplied as a partial extract.

`crosscheck.py` is the part worth keeping. It replays the new notes against the
bills of materials already in Supabase, which were derived from **different**
notes at **different** batch sizes. Rates that agree across two independent
batches are trustworthy; rates that diverge are a finding, not a nuisance.

## Watch for

- **`pdftotext -layout` can silently drop a line.** It collapsed item 7 of
  DLE25020008. Always compare the item numbers found by `-layout` against `-raw`,
  and expect them to run 1..N with no gaps. A gap means a dropped item or a
  partial extract.
- **A note can carry two products** (DLE25000006 has both Noise Defender sizes)
  and then its single set of packaging lines cannot be attributed to either.
- **The code cell is sometimes blank.** Three lines across the 2026-09 tranche.
  Resolve by exact description match against `bamida_material_stock.item_name`,
  never fuzzily, and record that you did.
- **Materials get substituted between notes.** This is the whole reason the
  observation archive exists. See the H10 finding below.

## What was loaded, 9 Sep 2026 (tranche 2)

18 delivery notes, 19 product observations, each transcribed line by line and
independently re-read and diffed by a second pass. 17 of 18 verified clean; the
18th was the `-layout` drop above, found by both the verifier and a separate
extraction-mode comparison.

- `mrp_bom_observation` + `_line`: all 19 observations, 444 lines. Nothing reads
  this yet. It exists so the next tranche is a diff.
- `mrp_bom_product` / `mrp_bom_component`: the **13 products that had no bill of
  materials at all**, 288 component rows. Inert until a Hub SKU is mapped to
  them in `mrp_bom_sku_map`, which is Juraj's call.
- The five products that already had one were **not touched**.

`tranche2-20260909.sql` is the SQL record of exactly that, idempotent.

## Open: H10 disagrees with production

`000728` gates today on `900 Serge Ferrari mesh` at 2.85 m²/unit, of which
137 m² is in stock, giving a ceiling of **48 units**. That came from
DLE26040009, April 2026.

DLE26080011, August 2026, batch 350, does not use `900` at all. It uses
`897 Sieťka 362- zelená (2050x1335 mm)`, a pre-cut panel, **one per barrier**,
with **4080 in stock**. It also draws `1781 Kovové istenie` once per pallet, not
twice, matching all ten other products.

On the August note H10's ceiling is **280**, bound by `1781` exactly like H9 and
H8. Production is reporting 48. The existing `mrp_bom_sku_map` row for `EBH10NA`
already carries the caveat that the April note looked like a variant; this is
the evidence. Confirm with Juraj which panel H10 uses today before changing it,
because it moves a live manufacturing ceiling by a factor of six.
