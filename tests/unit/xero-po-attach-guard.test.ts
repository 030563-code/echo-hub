import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Attaching a PDF to Xero can never create a purchase order.
 *
 * Dean, 16 Sep 2026: "Make sure you dont reput the POs into Xero." Two Xero
 * purchase orders already exist for this chain and a duplicate would be real
 * money on a real ledger, so the rule is held here rather than in anybody's
 * memory of which webhook does what.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const LIB = 'src/lib/xero/attach-po-pdf.ts'
const ACTION = 'src/app/actions/purchase-orders/attach-po-pdf.ts'
const DECIDE = 'src/app/actions/purchase-orders/decide-po.ts'
/** Where the approval's post to n8n lives since 24 Sep 2026, shared by decide-po and the retry. */
const HANDOFF = 'src/app/actions/purchase-orders/xero-handoff.ts'
const RETRY = 'src/app/actions/purchase-orders/send-to-xero-again.ts'

/** The body of one exported function, so a later export cannot answer for it. */
const fn = (src: string, name: string) => {
  const start = src.indexOf(`export async function ${name}`)
  expect(start).toBeGreaterThan(-1)
  const next = src.indexOf('\nexport ', start + 1)
  return src.slice(start, next === -1 ? undefined : next)
}

describe('the attach path cannot create a purchase order', () => {
  const lib = code(LIB)

  it('never touches the webhook that creates Xero purchase orders', () => {
    expect(lib).not.toContain('N8N_PO_APPROVED_WEBHOOK_URL')
    expect(code(ACTION)).not.toContain('N8N_PO_APPROVED_WEBHOOK_URL')
    // And it posts to exactly one place, its own.
    expect((lib.match(/process\.env\.N8N_[A-Z_]*_URL/g) ?? [])).toEqual([
      'process.env.N8N_XERO_PO_ATTACH_WEBHOOK_URL',
    ])
  })

  it('refuses unless Xero already holds the order', () => {
    const repair = fn(lib, 'attachPoPdfToXero')
    expect(repair).toContain('!po.xero_po_id || !po.xero_tenant_id')
    // The refusal comes before the render and before any post.
    const guard = repair.indexOf('!po.xero_po_id')
    expect(guard).toBeLessThan(repair.indexOf('renderPoPdfForXero(po)'))
    expect(guard).toBeLessThan(repair.indexOf('fetch('))
  })

  it('sends the tenant and the order id the Hub already holds, never a guess', () => {
    expect(lib).toContain('xero_tenant_id: po.xero_tenant_id')
    expect(lib).toContain('xero_po_id: po.xero_po_id')
  })

  it('sends nothing at all from the staging sandbox', () => {
    expect(lib).toContain('externalCallsDisabled()')
  })
})

describe('the action is gated like every other purchase order write', () => {
  const src = code(ACTION)

  it('needs po.approve and the organisation that holds the chain', () => {
    expect(src).toContain("auth.capabilities.has('po.approve')")
    expect(src).toContain('poChainHeldBy(poId, auth.profile.organisations)')
  })

  it('is the only export, so nothing else on this endpoint is callable', () => {
    expect([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1])).toEqual(['attachPoPdf'])
  })
})

describe('the purchase order PDF renders on the server as well as the browser', () => {
  const src = code('src/lib/po-pdf.ts')

  it('buildPoPdf returns the document and saves nothing', () => {
    const start = src.indexOf('export async function buildPoPdf')
    const end = src.indexOf('export async function downloadPoPdf')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).not.toContain('.save(')
  })

  it('the browser wrapper is the only thing that saves', () => {
    expect(src).toMatch(/export async function downloadPoPdf[\s\S]{0,200}d\.save\(poPdfFilename\(po\)\)/)
  })

  it('a server render supplies its own logo, because there is no origin to fetch from', () => {
    expect(code('src/lib/pdf-brand.ts')).toContain('opts.logoDataUrl ?? (await loadLogoDataUrl())')
    expect(code(LIB)).toContain('logoDataUrl: await serverLogoDataUrl()')
  })
})

describe('the document goes on in the same run that creates the order', () => {
  const decide = code(DECIDE)
  const handoff = code(HANDOFF)
  const retry = code(RETRY)
  const lib = code(LIB)

  it('approval carries the document, so n8n needs no second call', () => {
    // Built in the hand-off, which the approval and "Send to Xero again" share,
    // so a retry carries the same document the approval did.
    expect(handoff).toContain('renderApprovalAttachment(po.id)')
    expect(handoff).toContain('attachment,')
  })

  it('renders only after the approval is committed, never before', () => {
    const approved = decide.indexOf('hub_approve_po_leg')
    expect(approved).toBeGreaterThan(-1)
    expect(approved).toBeLessThan(decide.indexOf('handOffApprovedLeg('))
  })

  it('sending again re-posts the approval and never approves again', () => {
    // Approving raises the next leg and freezes the cost. A retry must do neither.
    expect(retry).toContain('handOffApprovedLeg(')
    expect(retry).not.toContain('hub_approve_po_leg')
    expect(retry).not.toContain('snapshotSroPoCost')
  })

  it('a document that will not render costs the PDF, never the order', () => {
    const render = fn(lib, 'renderApprovalAttachment')
    expect(render).toContain('catch')
    expect(render).toContain('return null')
    // It renders and hands back bytes. It posts nowhere itself.
    expect(render).not.toContain('fetch(')
  })

  it('approving still posts to exactly one webhook, the one that creates the order', () => {
    expect(handoff.match(/process\.env\.N8N_[A-Z_]*_URL/g) ?? []).toEqual([
      'process.env.N8N_PO_APPROVED_WEBHOOK_URL',
    ])
    // Neither caller posts anywhere of its own.
    expect(decide.match(/process\.env\.N8N_[A-Z_]*_URL/g) ?? []).toEqual([])
    expect(retry.match(/process\.env\.N8N_[A-Z_]*_URL/g) ?? []).toEqual([])
  })
})
