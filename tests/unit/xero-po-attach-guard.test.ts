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
    expect(lib).toContain('!po.xero_po_id || !po.xero_tenant_id')
    // The refusal comes before the render and before any post.
    const guard = lib.indexOf('!po.xero_po_id')
    expect(guard).toBeLessThan(lib.indexOf('renderPoPdfForXero(po)'))
    expect(guard).toBeLessThan(lib.indexOf('fetch('))
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
