import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPoPdfData } from '@/lib/po-pdf-data'

/**
 * Who a purchase order says it is from, and where that company is.
 *
 * Dean, 22 Sep 2026: "Important to also double check does the addresses on the
 * POs for the different regions also carry across on the PO documents and not
 * just hardcoded to US?" They did not. The first leg of every chain is raised BY
 * a depot code (US-BAL, EU-FR, GB-BSE), and only the US and Canadian ones were
 * turned into a company by hand. Every other region fell through to the
 * delivery-address label, so EBFRA8001 was placed by "France depot".
 *
 * The rows below are the live ones from the operations project on 22 Sep 2026,
 * placeholders included: four entities still read "Confirm registered address"
 * and three ship-to rows read "confirm ship-to address". A note to ourselves is
 * never printed on a document somebody outside the company reads.
 */

const ENTITIES = [
  { code: 'EB-AUSTRALIA', legal_name: 'Echo Barrier Australia Pty Ltd', address_lines: ['Confirm registered address'] },
  { code: 'EB-CANADA', legal_name: 'Echo Barrier Canada, Inc', address_lines: ['Confirm registered address'] },
  { code: 'EB-FRANCE', legal_name: 'Echo Barrier SAS', address_lines: ['Confirm registered address'] },
  { code: 'EB-GROUP', legal_name: 'Echo Barrier Group Limited', address_lines: ['41 Central Chambers', 'Dame Court', 'Dublin', 'D02 W729', 'Republic of Ireland'] },
  { code: 'EB-SRO', legal_name: 'Echo Barrier s.r.o.', address_lines: ['Sturova 3/6', '040 01 Kosice', 'Slovakia'] },
  { code: 'EB-UK', legal_name: 'Echo Barrier Limited', address_lines: ['Confirm registered address'] },
  { code: 'EB-USA', legal_name: 'Echo Barrier USA LLC', address_lines: ['Capitol Warehouse', '8125 Stayton Drive', 'Jessup', 'MD 20794', 'USA'] },
]

const DELIVERY = [
  { entity: 'AU-SYD', label: 'Australia depot, Sydney', address: '- confirm ship-to address -' },
  { entity: 'CA-HAM', label: 'CA — Hamilton depot', address: '— confirm ship-to address —' },
  { entity: 'EB-GROUP', label: 'EB Group', address: '118A Newmarket Rd, Bury Saint Edmunds IP33 3TF, United Kingdom\n' },
  { entity: 'EB-SRO', label: 'EB SRO (Slovakia)', address: '— confirm address —' },
  { entity: 'EU-FR', label: 'France depot', address: 'ESPACE DISTRIB, Route de Noailles 60730, Cauvigny, FRANCE' },
  { entity: 'GB-BSE', label: 'UK depot, Bury St Edmunds', address: '118A Newmarket Rd, Bury Saint Edmunds IP33 3TF, United Kingdom\n' },
  { entity: 'US-BAL', label: 'US — Baltimore depot', address: 'Capitol Warehouse, 8125 Stayton Drive, Jessup, MD 20794, USA' },
  { entity: 'US-SBD', label: 'US — San Bernardino depot', address: '9119 Milliken Ave, Rancho Cucamonga, CA 91730' },
]

const SUPPLIERS = [{ name: 'Bamida s.r.o.', address: 'Kosicka 28\n080 01 Presov\nSlovakia' }]

const TABLES: Record<string, unknown[]> = {
  entities: ENTITIES,
  po_delivery_addresses: DELIVERY,
  po_suppliers: SUPPLIERS,
}

function clientFor(tables: Record<string, unknown[]>): SupabaseClient {
  return {
    from: (table: string) => ({ select: async () => ({ data: tables[table] ?? [] }) }),
  } as unknown as SupabaseClient
}

const load = () => getPoPdfData(clientFor(TABLES))

describe('a purchase order is placed by a company, not by a depot', () => {
  it('names the organisation that owns the depot, in every region', async () => {
    const { parties } = await load()
    expect(parties['US-BAL'].name).toBe('Echo Barrier USA LLC')
    expect(parties['US-SBD'].name).toBe('Echo Barrier USA LLC')
    expect(parties['CA-HAM'].name).toBe('Echo Barrier Canada, Inc')
    expect(parties['EU-FR'].name).toBe('Echo Barrier SAS')
    expect(parties['GB-BSE'].name).toBe('Echo Barrier Limited')
    expect(parties['AU-SYD'].name).toBe('Echo Barrier Australia Pty Ltd')
  })

  it('no depot label reaches the From block as a company name', async () => {
    const { parties } = await load()
    const names = Object.values(parties).map((p) => p.name)
    for (const label of DELIVERY.map((d) => d.label)) {
      expect(names, `${label} is a depot, not a company`).not.toContain(label)
    }
  })

  it('prints the depot street address, because that is where the goods are', async () => {
    const { parties } = await load()
    expect(parties['EU-FR'].lines).toEqual(['ESPACE DISTRIB', 'Route de Noailles 60730', 'Cauvigny', 'FRANCE'])
    expect(parties['US-SBD'].lines).toEqual(['9119 Milliken Ave', 'Rancho Cucamonga', 'CA 91730'])
    expect(parties['GB-BSE'].lines).toEqual(['118A Newmarket Rd', 'Bury Saint Edmunds IP33 3TF', 'United Kingdom'])
  })

  it('Baltimore and the registered address are the same building', async () => {
    const { parties } = await load()
    expect(parties['US-BAL'].lines).toEqual(['Capitol Warehouse', '8125 Stayton Drive', 'Jessup', 'MD 20794', 'USA'])
  })

  it('falls back to the registered address when the depot has none', async () => {
    // Not a case the live data reaches yet: the two depots with no ship-to
    // belong to the two entities with no registered address either. It is the
    // case the day Dean fills one of them in, so pin it now.
    const { parties } = await getPoPdfData(
      clientFor({
        entities: ENTITIES.map((e) =>
          e.code === 'EB-AUSTRALIA' ? { ...e, address_lines: ['Unit 4', '12 Hume Highway', 'Sydney NSW 2000', 'Australia'] } : e,
        ),
        po_delivery_addresses: DELIVERY,
        po_suppliers: SUPPLIERS,
      }),
    )
    expect(parties['AU-SYD'].name).toBe('Echo Barrier Australia Pty Ltd')
    expect(parties['AU-SYD'].lines).toEqual(['Unit 4', '12 Hume Highway', 'Sydney NSW 2000', 'Australia'])
  })
})

describe('an unfilled address is a note to ourselves', () => {
  it('never prints a confirm-this placeholder, from either table', async () => {
    const { parties } = await load()
    const every = Object.values(parties).flatMap((p) => [p.name, ...p.lines])
    for (const line of every) expect(line).not.toMatch(/confirm/i)
  })

  it('leaves the address empty rather than inventing one', async () => {
    const { parties } = await load()
    expect(parties['CA-HAM'].lines).toEqual([])
    expect(parties['AU-SYD'].lines).toEqual([])
  })
})

describe('the entity parties keep their registered addresses', () => {
  it('Group is Dublin, not the Bury St Edmunds ship-to it also has a row for', async () => {
    const { parties } = await load()
    expect(parties['EB-GROUP'].name).toBe('Echo Barrier Group Limited')
    expect(parties['EB-GROUP'].lines[0]).toBe('41 Central Chambers')
    expect(parties['EB-GROUP'].lines).toContain('Republic of Ireland')
  })

  it('s.r.o. is Kosice, and the supplier leg is Bamida', async () => {
    const { parties } = await load()
    expect(parties['EB-SRO'].lines).toEqual(['Sturova 3/6', '040 01 Kosice', 'Slovakia'])
    expect(parties['SUPPLIER'].name).toBe('Bamida s.r.o.')
    expect(parties['SUPPLIER'].lines).toEqual(['Kosicka 28', '080 01 Presov', 'Slovakia'])
  })
})

describe('no region is named in the code any more', () => {
  it('the builder hardcodes no company name and no depot prefix', () => {
    const source = readFileSync('src/lib/po-pdf-data.ts', 'utf8')
    expect(source).not.toContain('Echo Barrier Canada Inc')
    expect(source).not.toContain('startsWith("US-")')
    expect(source).not.toContain('startsWith("CA-")')
    expect(source).toContain('orgForDepot(d.entity)')
  })
})
