import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

const RAISE = 'src/app/actions/purchase-orders/raise-manufacturing-po.ts'
const STOCK = 'src/app/actions/purchase-orders/fulfil-from-stock.ts'
const SEND = 'src/app/actions/purchase-orders/send-manufacturing-po.ts'
const MIGRATION = 'supabase/migrations/20260908130000_po_manufacturing.sql'
const APPROVE = 'supabase/migrations/20260908120000_sro_fulfilment_no_auto_mint.sql'

describe("every export is gated, because a 'use server' export is an endpoint", () => {
  for (const file of [RAISE, STOCK, SEND]) {
    it(`${file} checks a capability on every action`, () => {
      const source = read(file)
      const actions = source.match(/export async function (\w+)/g) ?? []
      expect(actions.length).toBeGreaterThan(0)
      expect((source.match(/getAuthorizedUser\(\)/g) ?? []).length).toBe(actions.length)
      expect((source.match(/capabilities\.has\("po\.create"\)/g) ?? []).length).toBe(actions.length)
    })
  }
})

describe('the fulfilment decision is made once', () => {
  it('raising manufacturing requires the SRO leg to still be approved', () => {
    const source = read(RAISE)
    expect(source).toContain('sro.leg !== "EB_GROUP_TO_SRO"')
    expect(source).toContain('sro.status !== "approved"')
  })

  it('survives a genuine race on the unique index, not just on the status read', () => {
    const source = read(RAISE)
    // A pre-check alone loses when two requests both read 'approved' before
    // either writes. The 23505 branch is what actually holds.
    expect(source).toContain('const UNIQUE_VIOLATION = "23505"')
    expect(source).toMatch(/childErr\?\.code === UNIQUE_VIOLATION[\s\S]{0,160}already exists/)
  })

  it('closes the door behind itself by moving the parent off approved', () => {
    expect(read(RAISE)).toMatch(/status: "in_manufacturing", fulfilment_type: "manufacture"[\s\S]{0,200}\.eq\("status", "approved"\)/)
  })

  it('choosing stock is a compare-and-set, so it cannot overwrite a manufacture', () => {
    const source = read(STOCK)
    expect(source).toMatch(/fulfilment_type: "stock"[\s\S]{0,200}\.eq\("status", "approved"\)/)
    expect(source).toContain('already being manufactured')
  })

  it('keeps to_entity as SUPPLIER, which is the code the PDF maps to Bamida', () => {
    expect(read(RAISE)).toContain('to_entity: "SUPPLIER"')
    expect(read('src/lib/po-pdf-data.ts')).toContain('parties["SUPPLIER"]')
  })
})

describe('the Bamida send is claimed before anything leaves', () => {
  const source = read(SEND)

  it('claims with a conditional update on sent_at, not with a label', () => {
    expect(source).toMatch(/\.update\(\{[\s\S]{0,400}sent_at: new Date\(\)[\s\S]{0,400}\}\)[\s\S]{0,120}\.is\("sent_at", null\)/)
    expect(source).toContain('already been sent to Bamida')
  })

  it('takes the claim BEFORE it posts to n8n', () => {
    expect(source.indexOf('.is("sent_at", null)')).toBeLessThan(source.indexOf('await fetch(webhookUrl'))
  })

  it('hands the claim back when nothing actually went out', () => {
    expect(source).toMatch(/if \(failure\)[\s\S]{0,400}\.update\(\{ sent_at: null \}\)/)
  })

  it('makes a resend a separate, deliberate action that a finished order refuses', () => {
    expect(source).toContain('export async function releaseBamidaSendClaim')
    expect(source).toMatch(/releaseBamidaSendClaim[\s\S]*\.is\("finished_at", null\)/)
  })

  it('refuses rather than guessing when Bamida have no configured address', () => {
    expect(source).toContain('BAMIDA_PO_TO')
    expect(source).toMatch(/if \(!bamidaTo\)[\s\S]{0,200}ok: false/)
  })

  it('sends nothing at all from the staging sandbox', () => {
    expect(source).toMatch(/externalCallsDisabled\(\)[\s\S]{0,160}ok: false/)
  })
})

describe('short materials change the wording, they do not stop the send', () => {
  const source = read(SEND)

  it('picks a template rather than returning an error', () => {
    expect(source).toMatch(/template: shortMaterials\.length > 0 \? "materials_short" : "standard"/)
    // Nothing anywhere refuses the send because of a shortage.
    expect(source).not.toMatch(/shortMaterials\.length > 0[\s\S]{0,80}return \{ ok: false/)
  })

  it('tells Bamida what is short and records what we believed at the time', () => {
    expect(source).toContain('short_materials: shortMaterials')
    expect(source).toMatch(/short_materials: shortMaterials\.length > 0 \? shortMaterials : null/)
  })
})

describe('the Hub decides who gets the email, not n8n', () => {
  it('resolves the Bamida recipients through the test switch', () => {
    const source = read(SEND)
    expect(source).toContain('resolveRecipients')
    expect(source).toMatch(/to: bamidaTo,[\s\S]{0,120}cc: process\.env\.BAMIDA_PO_CC/)
    expect(source).toContain('intended: recipients.intended')
  })
})

describe('po_manufacturing is not reachable from a browser', () => {
  const sql = read(MIGRATION)

  it('turns RLS on and revokes every grant', () => {
    expect(sql).toContain('enable row level security')
    // RLS does not restrain TRUNCATE, and this project grants it to
    // `authenticated` on every new table in public by default.
    expect(sql).toMatch(/revoke all on public\.po_manufacturing from public, anon, authenticated/)
  })

  it('pins the two fulfilment types the column may hold', () => {
    expect(sql).toMatch(/fulfilment_type in \('stock', 'manufacture'\)/)
  })
})

describe('approving the SRO leg raises nothing', () => {
  const sql = read(APPROVE)

  it('makes EB_GROUP_TO_SRO mint no child', () => {
    expect(sql).toMatch(/elsif v_po\.leg = 'EB_GROUP_TO_SRO' then[\s\S]{0,300}v_next_leg := null;[\s\S]{0,80}v_awaiting := true;/)
  })

  it('leaves the depot leg raising the SRO leg exactly as before', () => {
    expect(sql).toMatch(/if v_po\.leg = 'DEPOT_TO_EB_GROUP' then\s*\n\s*v_next_leg := 'EB_GROUP_TO_SRO'/)
  })

  it('says the order is waiting rather than letting the app claim the chain is done', () => {
    expect(sql).toContain("'awaiting_fulfilment', v_awaiting")
    expect(read('src/app/(dashboard)/purchase-orders/approvals/approvals-client.tsx')).toContain(
      'res.awaitingFulfilment',
    )
  })
})

describe('the bill of materials survives the new status', () => {
  it('still loads an SRO order once it moves to in_manufacturing', () => {
    // loadSroPoBoms filtered on 'approved' alone. Choosing to manufacture moves
    // the leg to in_manufacturing, which would have hidden the very order whose
    // BOM the Bamida document is built from.
    expect(read('src/lib/bom.ts')).toContain("'approved', 'in_manufacturing'")
  })
})
