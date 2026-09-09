import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The purchase order page is now the place you run one order from.
 *
 * Dean, 9 Sep 2026: the email link takes you to the order, and from there you
 * should be able to set things and change them rather than going elsewhere.
 *
 * Growing a viewer into a control surface is where a screen quietly acquires the
 * power to break the chain, so these pin the rules rather than the layout.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const PAGE = read('src/app/(dashboard)/purchase-orders/[id]/page.tsx')
const LOADER = read('src/lib/po-detail.ts')
const CARD = read('src/app/(dashboard)/purchase-orders/[id]/approval-card.tsx')
const TYPES = read('src/lib/erp-types.ts')

describe('the page never writes a status by hand', () => {
  it('has no status dropdown and no status write', () => {
    // Every status change is a side effect of a named action that owns its
    // guard. A bare write skips the next tier, the cost snapshot, the Xero
    // hand-off, the stock movement, or all four.
    expect(PAGE).not.toMatch(/update\(\{\s*status/)
    expect(PAGE).not.toMatch(/<select[^>]*status/i)
    expect(PAGE).not.toMatch(/setPoStatus|updateStatus|markShipped|markDelivered|cancelPo/i)
  })

  it('never names the one value that reaches a live n8n workflow', () => {
    // An INSERT with sro_evaluating fires trg_notify_po_phase2 into the Slack
    // stock-versus-manufacture flow. The Hub never writes it, and this page
    // must not put it in front of anybody either.
    expect(PAGE).not.toContain('sro_evaluating')
  })

  it('writes lifecycle_stage only, and says that is board placement', () => {
    const stage = read('src/app/(dashboard)/purchase-orders/[id]/stage-control.tsx')
    expect(stage).toContain('setPoStage')
    expect(stage).toMatch(/does not change the order&apos;s status/)
    // The RPC rejects null, so an option to clear it could only ever error.
    expect(stage).not.toMatch(/stage:\s*null/)
  })
})

describe('what may be pressed, and by whom', () => {
  it('offers approve or reject only on an order actually awaiting Hub approval', () => {
    expect(PAGE).toMatch(/awaitingApproval =\s*po\.source === 'hub' && po\.status === 'requested'/)
    expect(PAGE).toMatch(/\{awaitingApproval && \([\s\S]{0,400}<ApprovalCard/)
  })

  it('makes the approval card refuse itself too, after its hooks', () => {
    // Defence in depth: the card is handed the two fields decide-po gates on.
    expect(CARD).toMatch(/if \(source !== 'hub' \|\| status !== 'requested'\) return null/)
    const hooks = CARD.indexOf("useState('')")
    const guard = CARD.indexOf("status !== 'requested'")
    expect(guard).toBeGreaterThan(hooks)
  })

  it('offers Log delivery on exactly the board condition, and nowhere else', () => {
    // Goods land at the depot that ordered them. The intercompany legs are
    // paperwork, and receiving is the only route to 'delivered'.
    expect(PAGE).toMatch(
      /canLogDelivery =\s*\n?\s*canReceive &&\s*\n?\s*po\.source === 'hub' &&\s*\n?\s*po\.status === 'approved' &&\s*\n?\s*po\.leg === 'DEPOT_TO_EB_GROUP' &&\s*\n?\s*!isFullyReceived/,
    )
  })

  it('keeps the shipment request behind a capability, not just row existence', () => {
    // Its payload carries the depot address and the forwarder's inbox.
    expect(PAGE).toMatch(/\{cargo && \(canDetectShipment \|\| canAct\) &&/)
  })
})

describe('a Bamida order can still be sent before anything has happened to it', () => {
  it('renders the manufacturing card on the LEG, not on the progress row existing', () => {
    // The regression this catches: a freshly raised Bamida order has no
    // po_manufacturing row, so keying the card on the row removed the very
    // button that sends it.
    expect(PAGE).toMatch(/isManufacturingOrder\s*\?\s*\{ sentAt: null/)
    expect(PAGE).toMatch(/\{isManufacturingOrder && progress && \(/)
  })
})

describe('the loader does not leak', () => {
  it('strips unit_price before the order can reach a client payload', () => {
    expect(LOADER).toMatch(/const \[po\] = stripPurchaseOrderCosts\(\[order\], canViewCost\)/)
    const strip = LOADER.indexOf('stripPurchaseOrderCosts([order]')
    expect(strip).toBeLessThan(LOADER.indexOf('po.attachments ='))
  })

  it('keeps recipient addresses off the type the board hands to the browser', () => {
    // PoManufacturing hangs off PurchaseOrder, and the board passes the whole
    // array into a client component. A recipient list on that type is one
    // wiring change away from shipping every viewer the addresses we email.
    const block = TYPES.slice(TYPES.indexOf('export interface PoManufacturing'))
    expect(block.slice(0, block.indexOf('}'))).not.toContain('sent_to')
    expect(LOADER).toContain('sentTo')
  })

  it('reads the service-role table with the named columns and no more', () => {
    expect(LOADER).toMatch(
      /\.select\('po_id, sent_at, sent_to, sent_was_test, est_start, est_finish, finished_at'\)/,
    )
  })

  it('takes the PDF rate from the chain root, like the board', () => {
    // Cost is entered on the depot leg in that depot's currency; the PDF
    // converts from there. Using this leg's entity prints the wrong rate.
    expect(PAGE).toMatch(/chain\.find\(\(l\) => l\.parent_po_id === null\)/)
  })
})

describe('what leaves the company carries names, not our codes', () => {
  const PDF = read('src/lib/po-pdf.ts')
  const SUPPLIER_PAGE = read('src/app/manufacturing/[token]/page.tsx')

  /**
   * Dean, 9 Sep 2026: the SKU "has nothing to do with them, it is an internal
   * database code", and the depot codes "should be the actual depot names".
   * These are documents and screens outside Echo Barrier reads.
   */
  it('keeps the purchase order document free of our internal fields', () => {
    expect(PDF).not.toContain('intercompany')
    expect(PDF).not.toMatch(/Approved by:/)
    expect(PDF).not.toMatch(/Status: \$\{po\.status\}/)
    expect(PDF).not.toMatch(/Reference: \$\{/)
    // The line table names the product; the SKU column is gone.
    expect(PDF).not.toMatch(/\["Ln", "SKU"/)
    expect(PDF).toMatch(/\["Ln", "Description", "Qty", "HS code"/)
  })

  it('leaves the money columns aligned after the SKU column went', () => {
    // autoTable aligns by index, so dropping a column silently right-aligns the
    // wrong ones unless these move too.
    expect(PDF).toContain('columnStyles: priced ? { 4: { halign: "right" }, 5: { halign: "right" } } : {}')
  })

  it('shows Bamida the product, not our SKU', () => {
    expect(SUPPLIER_PAGE).not.toMatch(/>Code</)
    expect(SUPPLIER_PAGE).toContain('{line.product_name || line.sku}')
  })

  it('resolves every entity code to a name, in one place', () => {
    const consts = read('src/lib/depot-constants.ts')
    expect(consts).toContain("'EB-SRO': 'Echo Barrier s.r.o.'")
    expect(consts).toContain("SUPPLIER: 'Bamida'")
    // An unmapped code still passes through: a code somebody recognises beats
    // a word that tells them nothing.
    expect(consts).toMatch(/ENTITY_MAPPING\[trimmed\] \?\? DEPOT_MAPPING\[trimmed\] \?\? trimmed/)
  })
})
