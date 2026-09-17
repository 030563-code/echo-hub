import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The rules that make it safe to hand an outside company a Hub login.
 *
 * Source grep, the house style of stock-write-guard and email-recipients-guard.
 * Every one of these is a rule somebody could undo in a single careless edit
 * and not notice for months, because the screen would still look right: a cost
 * column added to a select, a capability check dropped from one action of four,
 * a policy left answering `true`. The failure is invisible until it is somebody
 * else's data on a supplier's screen.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

/**
 * Comments explain the rule; only the CODE can break it.
 *
 * Several files below SAY the forbidden words while explaining why they do not
 * use them, and a guard that trips on its own reason is useless.
 */
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * Names the manufacturer's own systems force on us: their feed's table, the
 * webhook that mails them, the document builder named after them, and their
 * supplier code. None of these reaches a screen. Anything else bearing the name
 * would be text somebody reads, which is what Dean asked to be rid of.
 */
const UNAVOIDABLE_IDENTIFIERS = [
  /bamida_material_stock(_history)?/g,
  /N8N_BAMIDA_PO_WEBHOOK_(URL|SECRET)/g,
  /buildBamidaPoPdf|buildBamidaPo|BamidaSupplier|bamidaPoPdfFilename|renderBamidaPoDocument/g,
  /'BAMIDA, s\.r\.o\.'/g,
  /@\/lib\/bamida-po(-pdf|-document)?/g,
]

const ACTIONS = 'src/app/actions/factory/orders.ts'
const NOTIFY = 'src/app/actions/factory/notify-po-confirmed.ts'
const UPDATES = 'src/lib/factory/updates.ts'
const ORDERS = 'src/lib/factory/orders.ts'
const STOCK = 'src/lib/factory/stock.ts'
const MIGRATION = 'supabase/migrations/20260916100000_factory_login.sql'
const ROLLBACK = 'supabase/migrations/rollback/20260916100000_factory_login.down.sql'

/** Every file the factory's own screens are built from. */
function factoryFiles(): string[] {
  const roots = ['src/app/(dashboard)/factory', 'src/lib/factory', 'src/app/actions/factory']
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${entry}`
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(entry)) out.push(rel)
    }
  }
  roots.forEach(walk)
  return out
}

describe("every action is gated, because a 'use server' export is an endpoint", () => {
  const source = read(ACTIONS)

  it('checks the session, a capability and the record on every export', () => {
    const exports = source.match(/export async function (\w+)/g) ?? []
    expect(exports.length).toBe(4)
    // One gate() per action, and gate() is the thing that does all three.
    expect((source.match(/await gate\(/g) ?? []).length).toBe(exports.length)
    expect(source).toContain('getAuthorizedUser()')
    expect(source).toContain('auth.capabilities.has(capability)')
    expect(source).toContain('factoryOrderVisible(poId)')
  })

  it('asks for factory.update to write and factory.view to read', () => {
    // Three writes (dates, confirm, finished) and one read (the document).
    // `await gate(`, so gate's own signature line is not counted as a call.
    expect((source.match(/await gate\([^)]*'factory\.update', t\)/g) ?? []).length).toBe(3)
    expect((source.match(/await gate\([^)]*'factory\.view', t\)/g) ?? []).length).toBe(1)
  })

  it('takes nothing about the order except its id', () => {
    // A po id plus dates, and nothing else. No prices, no recipients, no
    // product names: an order is what WE sent, not what the caller describes.
    expect(source).toContain("const PoId = z.object({ poId: z.string().uuid() })")
    // The only schemas are the id and the two dates. Nothing the caller sends
    // describes the order itself.
    const schemas = source.match(/z\.object\(\{[\s\S]*?\}\)/g) ?? []
    expect(schemas.length).toBe(1)
    expect(source).toMatch(/const DatesSchema = PoId\.extend\(\{ estStart: DateInput, estFinish: DateInput \}\)/)
  })

  it('answers the same way for an order that is not theirs as for one that does not exist', () => {
    expect(source).toContain('error: t.errOrderNotYours')
    // One refusal, used once, so the two cases cannot drift apart.
    expect((source.match(/errOrderNotYours/g) ?? []).length).toBe(1)
  })

  it('says everything in the manufacturer\'s language, resolved once per call', () => {
    // Four actions, four resolutions, and gate is handed the same table rather
    // than reading the cookie again, so one call cannot answer in two languages.
    expect((source.match(/await factoryStrings\(\)/g) ?? []).length).toBe(4)
    expect(source).toContain('async function gate(poId: string, capability:')
    expect(source).toContain('t: FactoryStrings)')
    // No English left where the manufacturer can see it.
    expect(source).not.toContain("'This order is not available.'")
    expect(source).not.toContain("'Invalid order'")
    expect(source).not.toContain("'Invalid dates'")
    expect(source).not.toContain('Please contact Echo Barrier')
  })
})

describe('the three steps hold their shape', () => {
  const source = read(UPDATES)

  it('refuses to confirm without both dates, because the dates ARE the confirmation', () => {
    expect(source).toContain('error: t.errBothDatesRequired')
    expect(source).toMatch(/if \(!dates\.estStart \|\| !dates\.estFinish\)/)
  })

  it('confirms exactly once, whatever the browser does', () => {
    expect(source).toMatch(
      /update\(\{[\s\S]{0,400}confirmed_at: confirmedAt[\s\S]{0,400}\}\)[\s\S]{0,160}\.is\('confirmed_at', null\)/,
    )
  })

  it('refuses to finish an order nobody confirmed', () => {
    expect(source).toMatch(/\.not\('confirmed_at', 'is', null\)[\s\S]{0,120}\.is\('finished_at', null\)/)
    expect(source).toContain('error: t.errConfirmFirst')
  })

  it('speaks through the string table, never a literal the factory would read', () => {
    // Every refusal in here reaches their screen, so none of them is a literal.
    const refusals = source.match(/return \{ ok: false, error: [^,\n}]+/g) ?? []
    expect(refusals.length).toBeGreaterThan(5)
    for (const refusal of refusals) {
      expect(refusal, refusal).toMatch(/error: t\.\w+/)
    }
  })

  it('finishes exactly once, and the timestamp is taken before the fan-out', () => {
    expect(source).toMatch(
      /update\(\{ finished_at: finishedAtIso, finished_by_uid: actorUid \}\)[\s\S]{0,200}\.is\('finished_at', null\)/,
    )
    const stamp = source.indexOf('update({ finished_at:')
    const drafted = source.indexOf('createCargoRequestDraft(')
    const told = source.indexOf('notifyReadyForShipment(')
    expect(stamp).toBeGreaterThan(-1)
    expect(drafted).toBeGreaterThan(stamp)
    expect(told).toBeGreaterThan(drafted)
  })

  it('never stamps a lifecycle stage, so a SPOT id can still move the card', () => {
    expect(source).not.toMatch(/lifecycle_stage:/)
  })

  it('never asks the forwarder for anything from the factory screen', () => {
    // They are a factory saying the barriers exist. That is not a decision to
    // book a container.
    expect(source).not.toContain('notifyCargoPartnerReady')
  })

  it('emails the confirmation only after the row is written', () => {
    const actions = read(ACTIONS)
    const confirmed = actions.indexOf('confirmManufacturingOrder(')
    const emailed = actions.indexOf('notifyPoConfirmed(')
    expect(confirmed).toBeGreaterThan(-1)
    expect(emailed).toBeGreaterThan(confirmed)
    // And a failed email never unwrites a confirmation we already have. The wording moved into the
    // strings table on 17 Sep, because it was the last English sentence that could reach a Slovak
    // screen: it said "Confirmed, and we have your dates" on a page that is otherwise all Slovak.
    expect(actions).toContain('t.errConfirmEmailFailed')
    const strings = read('src/lib/factory/strings.ts')
    expect(strings).toContain('Confirmed, and we have your dates.')
    expect(strings).toContain('Potvrdené, vaše termíny máme.')
  })
})

describe('nothing on the factory screens names them, or costs anything', () => {
  const files = factoryFiles()

  it('self-check: the files are there, so a bad path cannot make this pass', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(files).toContain('src/lib/factory/orders.ts')
    expect(files).toContain('src/app/(dashboard)/factory/page.tsx')
  })

  it('never prints the manufacturer’s name', () => {
    // Dean, 16 Sep 2026: "Do not put Bamidas name in it". Their own screens say
    // Echo Barrier and say the order number; whose factory it is, they know.
    const offenders = files.filter((f) => {
      let body = code(f)
      for (const identifier of UNAVOIDABLE_IDENTIFIERS) body = body.replace(identifier, '')
      return /bamida/i.test(body)
    })
    expect(offenders, `these name the manufacturer: ${offenders.join(', ')}`).toEqual([])
  })

  it('never reads a cost, or the poisoned availability figures', () => {
    // unit_price and the snapshots are ours. available_quantity and reserved
    // are their feed's own broken numbers: reservations their system never
    // drains, so they read deeply negative against stock on the shelf.
    const forbidden = /unit_price|cost_snapshot|sro_cost_snapshot_eur|cost\.view|available_quantity|reserved/
    const offenders = files.filter((f) => forbidden.test(code(f)))
    expect(offenders, `these reach for a cost or a poisoned figure: ${offenders.join(', ')}`).toEqual([])
  })

  it('never imports the two modules that would print the name for them', () => {
    // entityLabel() renders SUPPLIER as the manufacturer's name, and the
    // document builder is named after them.
    for (const f of files) {
      expect(code(f), f).not.toContain('@/lib/depot-constants')
      // The download action is the one exception: it builds the very document
      // the manufacturer asked for, and no string from it reaches the screen.
      if (f !== 'src/app/actions/factory/orders.ts') {
        expect(code(f), f).not.toContain('@/lib/bamida-po')
      }
    }
  })
})

describe('the row scope is one predicate, written once', () => {
  const source = read(ORDERS)

  it('shows only a sent manufacturing leg', () => {
    expect(source).toContain(".not('sent_at', 'is', null)")
    expect(source).toContain("'SRO_TO_SUPPLIER'")
    expect(source).toContain("'SUPPLIER'")
  })

  it('reads with the service role, because can_read_po would let far too much in', () => {
    // Granting this account po.view to make a session read work would hand it
    // every purchase order in the chain over PostgREST.
    expect(source).toContain('createAdminClient')
    expect(source).not.toContain('createServerClient')
  })

  it('reads the feed as the CALLER, so a wrong policy breaks the page loudly', () => {
    const stock = read(STOCK)
    expect(stock).toContain('createServerClient')
    expect(stock).not.toContain('createAdminClient')
    expect(stock).toContain("select('ns_number, item_name, quantity, unit, availability, last_synced_at')")
    expect(stock).toContain("eq('is_active', true)")
  })
})

describe('the confirmation email goes through the one switch', () => {
  const source = read(NOTIFY)

  it('resolves recipients, so the test override cannot be bypassed', () => {
    expect(source).toContain('resolveRecipients')
    expect(source).toContain('readyNotifyRecipients')
  })

  it('carries the dates it is a receipt for, and no SKU', () => {
    expect(source).toContain('est_start')
    expect(source).toContain('est_finish')
    expect(source).toContain('confirmed_at')
    expect(code(NOTIFY)).not.toMatch(/\bsku\b/i)
  })

  it('sends nothing from the staging sandbox', () => {
    expect(source).toMatch(/externalCallsDisabled\(\)/)
  })

  it('goes to the addresses the order was sent to, never to the login', () => {
    // Dean, 16 Sep 2026: "cant we link an email to a PO by what Juraj put in in
    // that step just before manufacturing?" One login may stand for several
    // people and its address may be one nobody at the factory reads, so the
    // receipt follows the order rather than whoever pressed the button.
    const actions = read(ACTIONS)
    expect(actions).toContain("select('intended_to, intended_cc, sent_to')")
    expect(actions).toContain('to: addressedTo')
    expect(code(ACTIONS)).not.toContain('auth.user.email')
    expect(code(NOTIFY)).not.toContain('toEmail')
  })
})

describe('the emailed purchase order became a notification', () => {
  const source = read('src/app/actions/purchase-orders/send-manufacturing-po.ts')

  it('records who the order was really addressed to, not only where mail went', () => {
    // sent_to is the test address while the switch is on. These two are what
    // the confirmation email reads back, so they must be the real audience.
    expect(source).toContain('intended_to: recipients.intended?.to ?? recipients.to')
    expect(source).toContain('intended_cc: recipients.intended?.cc ?? recipients.cc')
  })

  it('attaches nothing and mints no link', () => {
    // Dean, 16 Sep 2026: "not to have the pdf attached but rather link to the
    // hub with their login".
    const body = code('src/app/actions/purchase-orders/send-manufacturing-po.ts')
    expect(body).not.toContain('attachment')
    expect(body).not.toContain('mintManufacturingLink')
    expect(body).not.toContain('link_expires_at')
  })

  it('points at the order inside the Hub', () => {
    expect(source).toContain('/factory/')
    expect(source).toContain('hubBaseUrl()')
  })

  it('still refuses to announce an order whose document cannot be built', () => {
    expect(source).toContain('loadSroPoBom')
  })
})

describe('the old signed-link door is shut', () => {
  it('has no public manufacturing route left', () => {
    expect(read('src/middleware.ts')).not.toMatch(/PUBLIC_PATHS[^\]]*'\/manufacturing'/)
  })

  it('leaves no token page, actions or minting behind', () => {
    for (const gone of [
      'src/app/manufacturing',
      'src/app/actions/manufacturing/supplier-updates.ts',
      'src/lib/manufacturing-token.ts',
    ]) {
      let exists = true
      try {
        statSync(join(process.cwd(), gone))
      } catch {
        exists = false
      }
      expect(exists, `${gone} should be gone`).toBe(false)
    }
  })
})

describe('the containment migration', () => {
  const up = read(MIGRATION)

  it('confines all thirty read-all policies and both feed tables', () => {
    for (const table of [
      'account_registry', 'bom_registry', 'capabilities', 'entities', 'item_catalog',
      'manufacturing_stocktake_lines', 'manufacturing_stocktakes', 'mrp_bom_component',
      'mrp_bom_map', 'mrp_bom_product', 'mrp_bom_sku_map', 'mrp_buffer_profile',
      'mrp_buffer_status_daily', 'mrp_ddsop_log', 'mrp_demand_events', 'mrp_lead_time_actuals',
      'mrp_spike_register', 'mrp_stage_weights', 'onix_sku_mapping', 'onix_warehouse_mapping',
      'po_delivery_addresses', 'po_hs_codes', 'po_line_receipts', 'po_product_catalog',
      'po_suppliers', 'product_depot_mapping', 'shipment_contents', 'shipment_events',
      'shipments', 'warehouse_stock_levels',
    ]) {
      expect(up, `${table} is not confined`).toContain(`('${table}', '`)
    }
    expect((up.match(/has_capability\('factory\.view'\)/g) ?? []).length).toBe(2)
  })

  it('defines internal as a granted staff account, and fails closed', () => {
    expect(up).toContain('create or replace function public.is_internal()')
    // "not external AND (super admin OR holds a capability)". A bare profiles
    // row is not a claim about anybody while self-signup is on.
    expect(up).toContain('user_capabilities')
    expect(up).toContain('revoke execute on function public.is_internal() from public, anon')
    expect(up).toContain('grant execute on function public.is_internal() to authenticated, service_role')
  })

  it('closes the Xero item-code master to the browser', () => {
    expect(up).toContain('drop policy if exists "Service role full access" on public.product_code_master')
    expect(up).toContain('revoke all on public.product_code_master from public, anon')
  })

  it('stops a session burning quote and PO numbers', () => {
    expect(up).toContain("raise exception 'forbidden: requires quotes.create'")
    expect(up).toContain('revoke all on sequence public.quote_ref_seq from public, anon, authenticated')
    expect(up).toContain('revoke execute on function public.generate_po_number() from public, anon, authenticated')
  })

  it('adds the flag, the guard clause and the six columns', () => {
    expect(up).toContain('is_external boolean not null default false')
    expect(up).toContain('new.is_external is distinct from old.is_external')
    expect(up).toContain('an external account cannot change its display name')
    for (const column of [
      'confirmed_at', 'confirmed_by_uid', 'confirmation_emailed_at',
      'confirmation_was_test', 'dates_updated_by_uid', 'finished_by_uid',
    ]) {
      expect(up, column).toContain(`add column if not exists ${column}`)
    }
  })

  it('refuses to commit if any read-all policy survived', () => {
    expect(up).toContain('read-all policies remain for signed-in roles')
  })

  it('has a rollback that deletes the grants by hand before the catalogue rows', () => {
    const down = read(ROLLBACK)
    const grants = down.indexOf('delete from public.user_capabilities')
    const rows = down.indexOf('delete from public.capabilities')
    expect(grants).toBeGreaterThan(-1)
    // The FK cascades, so deleting the catalogue first would take every grant
    // with it silently.
    expect(rows).toBeGreaterThan(grants)
  })
})

describe('the shell knows who it is drawing for', () => {
  it('drops the home row for an external account', () => {
    expect(read('src/components/nav/sidebar.tsx')).toContain('includeHome: !isExternal')
  })

  it('sends them to their own tab instead of the module list', () => {
    expect(read('src/app/(dashboard)/page.tsx')).toContain("redirect('/factory')")
  })

  it('clamps an external account in code as well as in the database', () => {
    const authz = read('src/lib/authz.ts')
    expect(authz).toContain("c.startsWith('factory.')")
    expect(authz).toMatch(/isExternal\s*\n?\s*\?\s*\[\]/)
  })
})
