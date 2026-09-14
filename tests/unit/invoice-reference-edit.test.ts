import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reference fields stay editable after TaxJar has filed the sale.
 *
 * Dean, 14 Sep 2026: "you should be able still to edit some of the fields after
 * the send to taxjar step like the customer PO reference number etc everything
 * you would need before sending the invoice".
 *
 * Three fields only, and the reason they are safe is precise: none of them is
 * in linesHash, none is sent to TaxJar, and none is in the billing snapshot. So
 * this guard pins the LIST as much as the behaviour. A fourth field added here
 * later, quietly, is how the Hub's record and a tax filing start to disagree.
 *
 * They do print on the document, which is what separates them from the Xero
 * coding fields: saving one on a documented invoice has to clear the stored PDF
 * hash and go back to filed, or the email refuses at the moment of sending.
 *
 * Source-grep in the house style (email-recipients-guard, invoice-mark-sent).
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SRC = read('src/app/actions/invoicing/save-reference.ts')
const EDITOR = read('src/app/(dashboard)/invoicing/[dealId]/invoice-editor.tsx')
const HASH = read('src/lib/customer-invoice/hash.ts')
const TAXJAR = read('src/app/actions/invoicing/record-taxjar.ts')

const FIELDS = ['customer_po_number', 'delivery_location', 'delivery_requested_by'] as const

describe('saveInvoiceReference', () => {
  it('self-check: the action was found', () => {
    expect(SRC.length).toBeGreaterThan(800)
    expect(SRC).toContain('export async function saveInvoiceReference')
  })

  it('is gated like every other invoicing write', () => {
    expect(SRC).toContain("'use server'")
    expect(SRC).toContain('requireInvoicingManage()')
    expect(SRC).toContain('Input.safeParse(input)')
  })

  it('takes no user id from the caller', () => {
    // The actor comes from the session, never the payload.
    expect(SRC).toContain('gate.auth.user.id')
    expect(SRC).not.toMatch(/uid:\s*z\./)
  })

  it('writes these three fields and nothing else', () => {
    for (const field of FIELDS) expect(SRC).toContain(`${field}:`)
    // Anything a tax calculation or a filing was made against stays out.
    for (const banned of [
      'delivery_street',
      'delivery_city',
      'delivery_state',
      'delivery_zip',
      'invoice_date',
      'due_date',
      'taxjar_customer_id',
      'is_collection',
      'unit_price',
      'quantity',
      'tax_total',
      'total',
    ]) {
      expect(SRC, `save-reference must not write ${banned}`).not.toContain(`${banned}:`)
    }
  })

  it('only runs at filed and documented', () => {
    expect(SRC).toMatch(/REFERENCE_EDITABLE_STATUSES = new Set\(\['filed', 'documented'\]\)/)
    // Re-tested in the write itself, so an invoice that moved mid-edit loses.
    expect(SRC).toMatch(/\.in\('status', \['filed', 'documented'\]\)[\s\S]{0,80}\.select\('id'\)/)
    expect(SRC).toMatch(/data\.length === 0/)
  })

  it('clears the stored PDF hash and goes back to filed when the invoice was documented', () => {
    // The three fields print, so a documented invoice must be regenerated
    // before it is emailed. Without this the email refuses on the hash check
    // with nothing telling the reviewer why.
    expect(SRC).toMatch(/regenerateNeeded = invoice\.status === 'documented'/)
    expect(SRC).toMatch(/regenerateNeeded \? \{ status: 'filed', pdf_sha256: null \}/)
  })

  it('records the edit, before and after', () => {
    expect(SRC).toContain("logInvoiceEvent(invoiceId, 'reference_edited'")
    expect(SRC).toMatch(/from: \{/)
    expect(SRC).toMatch(/to: next/)
  })

  it('writes nothing when nothing changed', () => {
    expect(SRC).toMatch(/if \(!changed\) return \{ success: true, regenerateNeeded: false \}/)
  })
})

describe('the three fields really are outside the tax path', () => {
  it('none of them is in linesHash', () => {
    expect(HASH.length).toBeGreaterThan(200)
    for (const field of FIELDS) expect(HASH, `${field} must not be hashed`).not.toContain(field)
  })

  it('none of them is sent to TaxJar', () => {
    expect(TAXJAR.length).toBeGreaterThan(1000)
    for (const field of FIELDS) expect(TAXJAR, `${field} must not reach TaxJar`).not.toContain(field)
  })
})

describe('the editor', () => {
  it('keeps the three boxes live at filed and documented', () => {
    expect(EDITOR).toMatch(/const referenceEditable = canManage && \(status === 'filed' \|\| status === 'documented'\)/)
    const enabled = EDITOR.match(/disabled=\{!editable && !referenceEditable\}/g) ?? []
    expect(enabled).toHaveLength(FIELDS.length)
  })

  it('gives them their own save, since the main Save button is gone by then', () => {
    expect(EDITOR).toContain('saveInvoiceReference')
    expect(EDITOR).toMatch(/referenceEditable && referenceDirty/)
    expect(EDITOR).toContain('Save reference fields')
  })

  it('says a documented invoice needs generating again', () => {
    expect(EDITOR).toMatch(/status === 'documented' && ' Saving asks for the PDF to be generated again\.'/)
  })
})
