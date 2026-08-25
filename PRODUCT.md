# Echo Barrier Hub: product context

register: product

## What it is
Internal operating platform for Echo Barrier: quotes, purchase orders, BOM,
MRP, transport. One app, single login, per-user capabilities. Not public,
never marketed; design serves the task.

## Users
- Sales reps (first: Jillian, US) creating and tracking customer quotes,
  often away from a desk. Phone use is a first-class case for the Quotes
  module.
- Ops/management (Dean, Dave) reviewing POs, stock boards and approvals,
  usually on desktop.

## Brand
Echo Barrier: black, white, orange #FF7026 (echobarrier.com). Headings in
Varela Round, body Roboto. Light UI for the sales surfaces; the ops boards
(purchase orders, MRP, transport) are deliberately dark, near-black panels.

## Tone
Plain, operational, no marketing language. Buttons say what they do.
Customer-facing output (the quote PDF) is governed separately: nothing
internal (SKUs, depots, template names) may appear there.

## Anti-references
Generic SaaS dashboard gloss; hero metrics; decorative motion. This is a
tool people use many times a day.

## Constraints that shape design
- Public repo: no secrets in code, ever.
- Every action is capability-gated server-side; UI hides what RLS forbids.
- Reps double-click when nothing responds: every navigation and submit
  must show a loading state.
