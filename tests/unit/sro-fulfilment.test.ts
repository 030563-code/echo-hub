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
  for (const file of [RAISE, STOCK]) {
    it(`${file} checks a capability on every action`, () => {
      const source = read(file)
      const actions = source.match(/export async function (\w+)/g) ?? []
      expect(actions.length).toBeGreaterThan(0)
      expect((source.match(/getAuthorizedUser\(\)/g) ?? []).length).toBe(actions.length)
      expect((source.match(/capabilities\.has\("po\.create"\)/g) ?? []).length).toBe(actions.length)
    })
  }

  /**
   * SEND is counted differently because two of its exports share one gate.
   *
   * Since 16 Sep 2026 the send and the confirmation dialog that precedes it are
   * the same reasoning, held in planManufacturingSend, so a one-gate-per-export
   * count no longer describes the file. The rule is unchanged and asserted more
   * tightly here: the planner gates, and no export starts work without reaching
   * a gate, its own or the planner's.
   */
  it(`${SEND} gates every export, its own or the shared planner's`, () => {
    const source = read(SEND)

    const names = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort()
    expect(names).toEqual([
      'previewManufacturingPoSend',
      'releaseBamidaSendClaim',
      'sendManufacturingPoToBamida',
    ])

    // The planner is defined before any export, so the chunks below cannot
    // borrow its gate by accident.
    expect(source.indexOf('async function planManufacturingSend')).toBeLessThan(
      source.indexOf('export async function'),
    )
    expect(source).toMatch(
      /async function planManufacturingSend[\s\S]{0,300}getAuthorizedUser\(\)[\s\S]{0,200}capabilities\.has\("po\.create"\)/,
    )

    for (const chunk of source.split('export async function ').slice(1)) {
      const name = chunk.slice(0, chunk.indexOf('('))
      const gated = /getAuthorizedUser\(\)/.test(chunk) || /planManufacturingSend\(/.test(chunk)
      expect(gated, `${name} reaches no capability check`).toBe(true)
    }

    // Exactly two gates: the planner's, and the one in releaseBamidaSendClaim.
    expect((source.match(/getAuthorizedUser\(\)/g) ?? []).length).toBe(2)
    expect((source.match(/capabilities\.has\("po\.create"\)/g) ?? []).length).toBe(2)
  })
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
    // The windows bound how far apart the pieces may drift, nothing more. They
    // were widened on 16 Sep 2026 when the claim began recording the order's
    // real audience (intended_to / intended_cc) alongside where mail went.
    expect(source).toMatch(/\.update\(\{[\s\S]{0,400}sent_at: new Date\(\)[\s\S]{0,700}\}\)[\s\S]{0,120}\.is\("sent_at", null\)/)
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

  it('cannot be told where to send a purchase order', () => {
    // 🔴 Dean, 17 Sep 2026: "here is the absolute point of contact to Bamida /
    // sklad@bamida.sk / It should no longer be an editable field." While `to`
    // and `cc` were optional inputs, ANY caller of this 'use server' export
    // could have the Hub send a real purchase order to an address of their
    // choosing. The schema now takes the PO id and nothing else.
    expect(source).toContain('const bamidaTo = FACTORY_CONTACT')
    expect(source).not.toMatch(/parsed\.data\.(to|cc)/)
    expect(source).not.toContain('BAMIDA_PO_TO')
    const schema = source.slice(source.indexOf('const Schema = z.object('), source.indexOf('const TIMEOUT_MS'))
    expect(schema).not.toContain('to:')
    expect(schema).not.toContain('cc:')
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
    // The address is now fixed on the server, but it STILL goes through
    // resolveRecipients so the test override wins and nothing reaches the real
    // factory while anybody is trying things out.
    expect(source).toContain('const bamidaTo = FACTORY_CONTACT')
    expect(source).toContain('const bamidaCc = factoryCopyTo()')
    expect(source).toMatch(/resolveRecipients\(\{[\s\S]{0,120}to: bamidaTo,[\s\S]{0,60}cc: bamidaCc,/)
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

describe('Ready for shipment reaches BOTH machines, and the migration is the half nothing else checks', () => {
  const READY = 'supabase/migrations/20260909140000_ready_for_shipment.sql'

  it('widens the status check, the stage check AND the RPC list', () => {
    const sql = read(READY)
    // Three places, and the third is the one that is easy to forget: the RPC
    // hardcodes the stage list a second time and RAISEs on anything else, so
    // without it a drag to the new column fails with "invalid stage".
    expect(sql).toContain('purchase_orders_status_check')
    expect(sql).toContain('purchase_orders_lifecycle_stage_chk')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.set_po_lifecycle_stage')
    expect((sql.match(/ready_for_shipment/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('drops before adding, because the original constraint was guarded against being widened', () => {
    const sql = read(READY)
    // The 2026-07-13 migration wrapped its ADD CONSTRAINT in an IF NOT EXISTS
    // on the constraint NAME, so re-running it would not widen anything.
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS purchase_orders_lifecycle_stage_chk/)
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS purchase_orders_status_check/)
  })

  it('keeps the RPC gated and never grants it to anon', () => {
    const sql = read(READY)
    expect(sql).toContain("has_capability('po.approve') OR public.has_capability('po.receive')")
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.set_po_lifecycle_stage(uuid, text) FROM PUBLIC, anon')
  })

  it('stops the finish button stamping a stage, so the SPOT id can still move the card', () => {
    const src = read('src/lib/factory/updates.ts')
    // A PERSISTED stage outranks derivation. Writing one here froze the card at
    // Shipping and made "Shipping only once it is booked" unreachable.
    expect(src).not.toMatch(/lifecycle_stage:\s*'shipping'/)
    expect(src).not.toMatch(/lifecycle_stage:/)
  })

  it('clears the parent SRO leg, which is what said Manufacturing about finished barriers', () => {
    const src = read('src/lib/factory/updates.ts')
    expect(src).toMatch(/update\(\{ status: 'ready_for_shipment' \}\)/)
    // Compare-and-set, so a leg somebody already moved on is not dragged back.
    expect(src).toMatch(/\.eq\('status', 'in_manufacturing'\)/)
  })
})

describe('Fulfilling from stock does what finishing does, because nothing else carries those goods', () => {
  it('records ready_for_shipment and keeps fulfilment_type saying which branch it was', () => {
    const src = read(STOCK)
    expect(src).toMatch(/status: "ready_for_shipment", fulfilment_type: "stock"/)
    // Still one conditional update, so a double press changes nothing twice.
    expect(src).toMatch(/fulfilment_type: "stock"[\s\S]{0,200}\.eq\("status", "approved"\)/)
  })

  it('reads which branch was already taken from fulfilment_type, not from status', () => {
    const src = read(STOCK)
    // The status moves on to ready_for_shipment on EITHER branch, so it can no
    // longer say which one was chosen. Keying the message on it would lie.
    expect(src).toMatch(/sro\.fulfilment_type === "manufacture"/)
    expect(src).toMatch(/sro\.fulfilment_type === "stock"/)
  })

  it('drafts the request and sends the email AFTER the claim, never before', () => {
    const src = read(STOCK)
    const claim = src.indexOf('.eq("status", "approved")')
    const drafted = src.indexOf('createCargoRequestDraft(')
    const told = src.indexOf('notifyReadyForShipment(')
    expect(claim).toBeGreaterThan(-1)
    expect(drafted).toBeGreaterThan(claim)
    expect(told).toBeGreaterThan(drafted)
  })

  it('collects from our own shelf, not from the factory', () => {
    expect(read(STOCK)).toMatch(/pickupFrom: "EB_SRO"/)
  })

  it('lets a webhook failure log, never turn a recorded decision into an error', () => {
    const src = read(STOCK)
    const told = src.indexOf('notifyReadyForShipment(')
    expect(src.slice(told)).not.toMatch(/return \{ ok: false/)
  })
})

describe('The shipment request pins what a person must not retype', () => {
  const CARGO = 'src/app/actions/purchase-orders/cargo-request.ts'

  it('overwrites the general reference with the order number on the server', () => {
    const src = read(CARGO)
    // Every export of a 'use server' file is a callable endpoint, so a disabled
    // input guarantees nothing. This is where it is actually fixed.
    expect(src).toMatch(/general_reference: po\.po_number \?\? parsed\.data\.draft\.general_reference/)
  })

  it('decides the pickup party from the order, not from the form', () => {
    const src = read(CARGO)
    expect(src).toMatch(/po\.fulfilment_type === 'stock' \? \('EB_SRO' as const\) : \('BAMIDA' as const\)/)
  })

  it('shows the general reference read-only rather than as an input', () => {
    const card = read('src/app/(dashboard)/purchase-orders/[id]/cargo-request-card.tsx')
    expect(card).not.toMatch(/set\('general_reference'/)
    expect(card).toContain('The purchase order number. Fixed.')
  })
})

describe('A draft written before a field existed still opens the page', () => {
  const STORE = 'src/lib/cargo-request-store.ts'

  it('completes the stored shape at the load boundary, not at each reader', () => {
    const src = read(STORE)
    // `request` is jsonb. A row written before pickup_from existed simply does
    // not have the key, and the cast on the way out claims otherwise. That took
    // the whole purchase order page down with "Cannot read properties of
    // undefined (reading 'name')".
    expect(src).toContain('function hydrateDraft')
    expect(src).toMatch(/draft: hydrateDraft\(data\.request\)/)
    // The raw cast is gone from the loader.
    expect(src).not.toMatch(/draft: data\.request as CargoDraft/)
  })

  it('defaults an unknown or missing pickup to the factory, and validates it', () => {
    const src = read(STORE)
    // Validated against the real list rather than a truthiness check, so a
    // hand-edited jsonb value cannot get through either.
    expect(src).toMatch(/PICKUP_FROM as readonly string\[\]\)\.includes\(draft\.pickup_from\)/)
    expect(src).toMatch(/: 'BAMIDA'/)
  })

  it('lets the card read the pickup party without defending itself', () => {
    // The point of fixing it at the boundary: the render stays plain.
    const card = read('src/app/(dashboard)/purchase-orders/[id]/cargo-request-card.tsx')
    expect(card).toContain('PICKUP_PARTIES[form.pickup_from]')
  })
})

describe('one point of contact at the manufacturer', () => {
  // Dean, 17 Sep 2026: "here is the absolute point of contact to Bamida /
  // sklad@bamida.sk / It should no longer be an editable field. In the future
  // everything ... will go to him."
  const contact = read('src/lib/factory-contact.ts')
  const card = read('src/app/(dashboard)/purchase-orders/[id]/manufacturing-card.tsx')

  it('holds the address in one place', () => {
    expect(contact).toContain("export const FACTORY_CONTACT = 'sklad@bamida.sk'")
  })

  it('has no address input left on the screen', () => {
    expect(card).not.toContain('setTo(')
    expect(card).not.toContain('setCc(')
    expect(card).not.toContain('bamida-to')
    expect(card).not.toContain('bamida-cc')
    // Shown, so the sender can see where it goes, but only shown.
    expect(card).toContain('{contact}')
    expect(card).toContain('Not editable')
  })

  it('still routes through the one test switch rather than adding a second', () => {
    // A hard-coded address that skipped resolveRecipients would email the real
    // factory during testing, which is the thing that switch exists to stop.
    expect(contact).toContain('HUB_EMAIL_TEST_RECIPIENT')
    expect(contact).not.toMatch(/process\.env\.BAMIDA_PO_TO/)
  })
})
