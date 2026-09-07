# Remembering where someone was

Every screen in the Hub used to hold its state in React and nowhere else, so
leaving a page threw it away. Open a deal, answer Quote Setup, add three lines,
step out to Pricing to check a number, come back: Quote Setup asked again and
the cart was empty. The same loss sat on the raise-PO form, the deal wizard, the
invoice editor, and every search box and filter on the board pages.

One table, one pair of hooks, one rule per screen.

## The two kinds

**Draft** is typed content: a cart, a wizard, a price sheet, a set of invoice
lines. It comes back with a visible strip saying so and a way to throw it away,
and it is deleted when the work it belongs to completes.

**View** is a filter, a search box, a tab, a sort. It comes back silently,
because nobody wants a banner about a search box.

Everything else is transient. A dialog's open flag, an in-flight submit, a drag
in progress: these die with the page and should.

## Adding a draft to a page

1. Put its shape in `src/lib/page-drafts.ts` as a zod schema with `v: 1`, a
   `parse…` function returning `null` on anything unreadable, and a key. Big
   shapes get their own module (`quote-builder-draft.ts`,
   `deal-wizard-draft.ts`).
2. Call `usePageState` with `pageKey`, `parse`, and an `onRestore` callback that
   puts the values back into the page's own state.
3. Call `save(...)` from one effect over exactly the fields worth keeping.
4. Render `<DraftStrip>` when something was restored. Pass `dark` on the
   operations screens.
5. Clear it when the work completes: `clear()` in the browser, and
   `deletePageState(key)` in the server action that finished the job, for the
   browser that was closed between the two.

## Adding view state to a page

`const [view, setView] = usePersistedView(key, initial, parse)`. That is all.
It renders `initial` immediately and applies the saved value when it arrives,
unless the user has already touched the control.

## The rules that are not obvious

**Read the draft in the browser, never as a server prop.** Next reuses a page
segment on browser Back regardless of staleness, so a draft delivered as a prop
comes back as whatever it was when the segment was first rendered. Go to
Pricing, press Back, and an empty cart lands on top of a full one. The one
server-side read that exists (the deal page's Resume label) only changes a word,
never data, and is documented as possibly lagging.

**Apply the restore in `onRestore`, never in a second effect.** React flushes
both effects in the same commit without re-rendering between them, so a persist
effect would run holding the pre-restore values and queue a write of the empty
seed over the draft. It is also the shape this codebase already settled on to
avoid cascading renders, in `change-stage-dialog.tsx`.

**Nothing is written until the read has finished, and nothing typed during it
is thrown away.** These two pull against each other and both were learned by
watching a real draft disappear. A page renders its defaults first, so an
unguarded save sends an empty form the instant it mounts and deletes the row
that is being read at that very moment. But simply dropping saves during the
read loses the last keystrokes whenever the read is slower than the typing,
which on a cold route it is. So a save made during the read is QUEUED, and when
the read finishes the queue is not flushed immediately: it arms the debounce
instead. The page reacts to the restore in the same tick, and its own save
either matches what the server holds, cancelling the queued one, or replaces it
with what was really typed. Both settle long before the timer fires.

**Guard a restore on whether the user typed, never on whether a dialog is
open.** Opening a dialog is not typing. Gating on `open` meant clicking Add
Shipment before the read landed skipped the restore, and the empty form then
deleted the saved draft. Keep a `touchedRef` set by the change handlers.

**Never store paging.** Not `page`, not `cursors`, not a table's page index. A
cursor belongs to the result set it came from, so restoring page 4 lands someone
on rows that have since moved, which reads as data loss. For the shared
`BoardTable`, TanStack also resets the page index whenever the row model
changes, so a restored sort would immediately write page 0 back anyway.

**One key, one call site.** A key is one row. Two components writing one key
overwrite each other's shape on every keystroke, and each one's parse of the
other's shape returns null. That is why the commercial invoices page has
`commercial-invoices:list` and `commercial-invoices:create`, and the BOM page
has `bom` and `bom:materials`.

**A draft over a record that moved needs a `base`.** Pass a fingerprint of the
record the draft was typed on. The quote builder flags staleness and restores
anyway, because a cart is the rep's own work. The invoice editor and the BOM
price sheet DISCARD it, because those numbers become a tax filing, a Xero
document, or a repricing of every product using a material.

**An untouched page leaves no row.** Give `isEmpty` a way to recognise the page
at its defaults, or merely opening a screen will offer to resume nothing.

## Keys in use

| Key | Kind | Where |
|---|---|---|
| `quote-builder:{dealId}` | draft | the quote builder |
| `quote-builder:{dealId}:edit:{quoteId}` | draft | the quote builder, editing a recalled quote |
| `deal-wizard` | draft | create a deal |
| `raise-po` | draft | raise a purchase order |
| `transport:add-shipment` | draft | Transport, Add Shipment |
| `invoice-editor:{invoiceId}` | draft | the customer invoice editor |
| `commercial-invoice:{invoiceId}` | draft | the commercial invoice line editor |
| `bom:material-prices` | draft | BOM, typed material prices |
| `quotes:filters` | view | the six quotes list routes |
| `po-board` | view | the purchase-order board |
| `po-board:table`, `mrp-board`, `transport:table` | view | the shared board table |
| `po-approvals`, `warehouse-stock`, `bom:materials`, `commercial-invoices:list`, `commercial-invoices:create` | view | search boxes |
| `bom` | view | the BOM tab |

## The guard

`tests/unit/page-state-guard.test.ts` walks the client components under
`src/app/(dashboard)` and `src/components`. Any file holding `useState` must
either use the hooks or carry a one-line marker:

```
// page-state: draft quote-builder:{dealId}
// page-state: view  po-board
// page-state: none (dialog-scoped, committed on save)
```

A new page with undeclared state fails CI. The point is not paperwork, it is
that somebody decided.

## Honest limits

- Closing a tab within about 700ms of the last keystroke loses that keystroke.
  Leaving by any normal navigation flushes immediately.
- A draft is per user and per browser session only in the sense that it lives in
  Postgres: the same person on a second device sees the same draft, and two tabs
  open on the same page will overwrite each other, last write winning.
- Storage is bounded at 100 keys per user and 60KB per key, both enforced in the
  database.
