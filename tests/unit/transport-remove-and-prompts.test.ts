import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dean, 24 Sep 2026: "i also cant delete a shipment if I make one by accident" and "I still dont
 * see the cost per barrier calculations". Source guards, the house style for server actions and
 * SQL; the function itself was called against the database before it was applied.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, '')

describe('taking a SPOT added by mistake off the board', () => {
  const action = code('src/app/actions/cargo/track.ts')
  const remove = action.slice(action.indexOf('export async function removeHandAddedShipment('))
  const sql = code('supabase/migrations/20260924200000_cargo_remove_hand_added_spot.sql')

  it('checks the caller and the shipment before it asks the database for anything', () => {
    const scope = remove.indexOf('await transportScope()')
    const inScope = remove.indexOf('await shipmentInScope(spotId, scope.depots)')
    const rpc = remove.indexOf(".rpc('cargo_remove_hand_added_spot'")
    expect(scope).toBeGreaterThan(-1)
    expect(inScope).toBeGreaterThan(scope)
    expect(rpc).toBeGreaterThan(inScope)
  })

  it('refuses a SPOT that anything else knows, before it deletes a row', () => {
    const firstDelete = sql.indexOf('delete from public.transport_shipment')
    for (const reason of ['in_sheet', 'on_order', 'customs_bill', 'commercial_invoice', 'in_transit_stock', 'lead_time', 'shared']) {
      const at = sql.indexOf(`return '${reason}'`)
      expect(at, reason).toBeGreaterThan(-1)
      expect(at, reason).toBeLessThan(firstDelete)
    }
    expect(sql).toContain('from eb_operations.shipments where btrim(spot_id) = p_spot_id')
    expect(sql).toContain('from public.cargo_tracked_spot where spot_id = p_spot_id for update')
  })

  it('removes the Hub copy and what was typed on it, and never touches the sheet or Cargo Partner', () => {
    expect(sql).toContain('delete from public.transport_shipment where spot_id = p_spot_id')
    expect(sql).toContain('delete from public.cargo_shipment where spot_id = p_spot_id')
    expect(sql).toContain('delete from public.cargo_tracked_spot where spot_id = p_spot_id')
    expect(sql).not.toMatch(/delete from eb_operations/i)
    expect(action).not.toMatch(/cargo-partner\.com/)
  })

  it('can be run by the service role only', () => {
    expect(sql).toContain('revoke all on function public.cargo_remove_hand_added_spot(text) from public, anon, authenticated')
    expect(sql).toContain('grant execute on function public.cargo_remove_hand_added_spot(text) to service_role')
  })

  it('is offered only on a SPOT that was added by hand', () => {
    const page = code('src/app/(dashboard)/transport/[spotId]/page.tsx')
    expect(page).toContain('isHandAddedSpot(spotId)')
    expect(page).toMatch(/\{handAdded && \(\s*<RemoveShipmentButton/)
  })

  it('says why a SPOT stays, for every reason the database gives', () => {
    for (const reason of ['not_hand_added', 'in_sheet', 'on_order', 'customs_bill', 'commercial_invoice', 'in_transit_stock', 'lead_time', 'shared']) {
      expect(action, reason).toMatch(new RegExp(`\\b${reason}:`))
    }
  })
})

describe('a shipment kept by hand has a Delete that can be found', () => {
  it('is a labelled button, not grey text in a corner', () => {
    const details = read('src/app/(dashboard)/transport/[spotId]/hand-shipment-details.tsx')
    expect(details).toContain('Delete this shipment')
    expect(details).toContain('border-red-200')
  })
})

describe('the landed cost card says how to get to a cost per barrier', () => {
  const card = read('src/app/(dashboard)/transport/[spotId]/landed-cost-card.tsx')

  it('names the two things it needs, and points at the sheet when it lists the contents', () => {
    expect(card).toContain('The cost per barrier is worked out here once the Hub has two things')
    expect(card).toContain('Start from the sheet under Contents')
    expect(card).toContain('href="#contents"')
    expect(read('src/app/(dashboard)/transport/[spotId]/shipment-contents.tsx')).toContain('id="contents"')
    expect(read('src/app/(dashboard)/transport/[spotId]/page.tsx')).toContain('sheetContents={contentsSummary(fromSheet)}')
  })

  it("has a real button for Group's invoice when there is none", () => {
    expect(card).toContain("Add Group&apos;s commercial invoice")
  })
})
