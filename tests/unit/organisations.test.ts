import { describe, it, expect } from 'vitest'
import {
  MODULE_ORGS,
  ORGANISATIONS,
  ORG_CODES,
  ORG_MODULES,
  currenciesForOrgs,
  depotsForOrg,
  holdsOrganisation,
  isOrgCode,
  moduleHasOrg,
  officesForOrg,
  officesForOrgs,
  orgForDepot,
  orgLabel,
  orgsForNavItem,
  orgsForPipeline,
  partiesForOrg,
  pipelineForOrg,
  sortOrgs,
  transportSeesAll,
  warehousesForOrg,
} from '@/lib/organisations'
import { resolveActiveOrg, safeNextPath, nextPathAfterSwitch } from '@/lib/active-organisation'
import { FLAG_CODES } from '@/components/ui/flag-icon'
import { PIPELINE_CONFIG } from '@/lib/pipeline-config'
import { DEPOT_MAPPING } from '@/lib/depot-constants'
import { OFFICES } from '@/lib/calls/offices'
import { STOCK_WAREHOUSES } from '@/lib/stock/warehouses'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

describe('the registry', () => {
  it('is the seven Xero organisations, once each, in the order Dean listed them', () => {
    expect(ORG_CODES).toEqual(['EB-USA', 'EB-CANADA', 'EB-FRANCE', 'EB-SRO', 'EB-GROUP', 'EB-AUSTRALIA', 'EB-UK'])
    expect(new Set(ORG_CODES).size).toBe(7)
    expect(ORGANISATIONS.map((o) => o.label)).toEqual(['USA', 'Canada', 'France', 'SRO', 'Group', 'Australia', 'UK'])
  })

  it('gives every organisation a flag the icon can draw', () => {
    for (const org of ORGANISATIONS) expect(FLAG_CODES, org.code).toContain(org.flag)
  })

  it('knows a code from anything else', () => {
    expect(isOrgCode('EB-USA')).toBe(true)
    expect(isOrgCode('eb-usa')).toBe(false)
    expect(isOrgCode('USA')).toBe(false)
    expect(isOrgCode(null)).toBe(false)
    expect(orgLabel('EB-SRO')).toBe('SRO')
    // Unknown passes through rather than becoming "Unknown".
    expect(orgLabel('EB-MARS')).toBe('EB-MARS')
  })

  it('sorts a set of codes into registry order and drops junk', () => {
    expect(sortOrgs(['EB-UK', 'nope', 'EB-USA'])).toEqual(['EB-USA', 'EB-UK'])
  })
})

describe('every mapping points at something that exists', () => {
  const knownPipelines = new Set(PIPELINE_CONFIG.map((p) => p.pipelineId))
  const knownDepots = new Set(Object.keys(DEPOT_MAPPING))

  it('pipelines are ones the Hub configures', () => {
    for (const code of ORG_CODES) {
      const pipeline = pipelineForOrg(code)
      if (pipeline !== null) expect(knownPipelines, `${code} -> ${pipeline}`).toContain(pipeline)
    }
  })

  it('depots are ones the depot mapping names', () => {
    for (const code of ORG_CODES) {
      for (const depot of depotsForOrg(code)) expect(knownDepots, `${code} -> ${depot}`).toContain(depot)
    }
  })

  it('offices are ones the phone system sends', () => {
    for (const code of ORG_CODES) {
      for (const office of officesForOrg(code)) expect(OFFICES, `${code} -> ${office}`).toContain(office)
    }
  })

  it('warehouses are ones the stock board knows', () => {
    for (const code of ORG_CODES) {
      for (const warehouse of warehousesForOrg(code)) {
        expect(STOCK_WAREHOUSES as readonly string[], `${code} -> ${warehouse}`).toContain(warehouse)
      }
    }
  })
})

describe('whole pipelines and whole offices, never a split (Dean, 15 Sep 2026)', () => {
  it('puts Canada on USA SALES and the USA office, the same as USA', () => {
    expect(pipelineForOrg('EB-CANADA')).toBe(HUBSPOT_PIPELINES.USA_SALES.id)
    expect(pipelineForOrg('EB-USA')).toBe(HUBSPOT_PIPELINES.USA_SALES.id)
    expect(officesForOrg('EB-CANADA')).toEqual(['USA'])
    expect(orgsForPipeline(HUBSPOT_PIPELINES.USA_SALES.id)).toEqual(['EB-USA', 'EB-CANADA'])
  })

  it('gives s.r.o. no sales pipeline: it manufactures', () => {
    expect(pipelineForOrg('EB-SRO')).toBeNull()
    expect(MODULE_ORGS.quotes).not.toContain('EB-SRO')
  })

  it('knows nothing about a pipeline nobody mapped', () => {
    expect(orgsForPipeline(HUBSPOT_PIPELINES.DEMO_SALES.id)).toEqual([])
    expect(orgsForPipeline(null)).toEqual([])
  })
})

describe('the depot side', () => {
  it('finds the organisation for a depot, in any case, and null for an unmapped one', () => {
    expect(orgForDepot('US-BAL')).toBe('EB-USA')
    expect(orgForDepot('ca-ham')).toBe('EB-CANADA')
    expect(orgForDepot('EU-FR')).toBe('EB-FRANCE')
    expect(orgForDepot('EU-France')).toBeNull()
    expect(orgForDepot(null)).toBeNull()
  })

  it('names a purchase-order party as the company plus its depots', () => {
    expect(partiesForOrg('EB-USA')).toEqual(['EB-USA', 'US-BAL', 'US-SBD'])
    expect(partiesForOrg('EB-GROUP')).toEqual(['EB-GROUP'])
  })

  it('lets s.r.o. and Group see every container, and a depot only its own', () => {
    expect(transportSeesAll('EB-SRO')).toBe(true)
    expect(transportSeesAll('EB-GROUP')).toBe(true)
    expect(transportSeesAll('EB-USA')).toBe(false)
  })
})

describe('several organisations at once', () => {
  it('unions offices in OFFICES order without repeats', () => {
    expect(officesForOrgs(['EB-CANADA', 'EB-USA', 'EB-UK'])).toEqual(['UK', 'USA'])
    expect(officesForOrgs([])).toEqual([])
  })

  it('unions currencies without repeats', () => {
    expect(currenciesForOrgs(['EB-FRANCE', 'EB-SRO', 'EB-USA'])).toEqual(['EUR', 'USD'])
  })

  it('answers the one question every write gate asks', () => {
    expect(holdsOrganisation(['EB-USA'], 'EB-USA')).toBe(true)
    expect(holdsOrganisation(['EB-USA'], 'EB-CANADA')).toBe(false)
    expect(holdsOrganisation(['EB-USA'], null)).toBe(false)
    expect(holdsOrganisation([], 'EB-USA')).toBe(false)
  })
})

describe('which organisations a module lists', () => {
  it('covers every module', () => {
    expect(Object.keys(MODULE_ORGS).sort()).toEqual([...ORG_MODULES].sort())
  })

  it('lists every organisation under Invoicing, the structure Dean asked for', () => {
    expect(MODULE_ORGS.invoicing).toEqual(ORG_CODES)
  })

  it('lists under Quotes only the organisations with a pipeline', () => {
    expect(MODULE_ORGS.quotes).toEqual(['EB-USA', 'EB-CANADA', 'EB-FRANCE', 'EB-GROUP', 'EB-AUSTRALIA', 'EB-UK'])
  })

  it('lists under Stock only the organisations holding stock', () => {
    expect(MODULE_ORGS.stock).toEqual(['EB-USA', 'EB-CANADA', 'EB-SRO'])
    expect(moduleHasOrg('stock', 'EB-FRANCE')).toBe(false)
  })

  it('shows a person only what they hold, in registry order', () => {
    expect(orgsForNavItem('invoicing', ['EB-UK', 'EB-USA'])).toEqual(['EB-USA', 'EB-UK'])
    expect(orgsForNavItem('stock', ['EB-UK', 'EB-USA'])).toEqual(['EB-USA'])
    expect(orgsForNavItem('quotes', ['EB-SRO'])).toEqual([])
    expect(orgsForNavItem(undefined, ORG_CODES)).toEqual([])
  })
})

describe('the active organisation', () => {
  it('is the cookie when the person holds it', () => {
    expect(resolveActiveOrg(['EB-USA', 'EB-CANADA'], 'EB-CANADA')).toBe('EB-CANADA')
  })

  it('falls back to the first organisation held, never to everything', () => {
    // A cookie for an organisation the person does not hold, a junk value, or
    // no cookie at all: every one of them lands on their own first organisation.
    expect(resolveActiveOrg(['EB-USA'], 'EB-CANADA')).toBe('EB-USA')
    expect(resolveActiveOrg(['EB-USA'], 'drop table')).toBe('EB-USA')
    expect(resolveActiveOrg(['EB-USA'], undefined)).toBe('EB-USA')
  })

  it('is null for a person who holds none', () => {
    expect(resolveActiveOrg([], 'EB-USA')).toBeNull()
  })
})

describe('where the switch sends the browser', () => {
  it('accepts a path on this site', () => {
    expect(safeNextPath('/invoicing')).toBe('/invoicing')
    expect(safeNextPath('/quotes/board?scope=all')).toBe('/quotes/board?scope=all')
  })

  it('refuses anything that could leave it', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, '/x y']) {
      expect(safeNextPath(bad), String(bad)).toBe('/')
    }
  })
})

describe('nextPathAfterSwitch: where the header flag lands you', () => {
  // Dean, 16 Sep 2026: "you should be able to click on the flag at the top
  // next to Echo Barrier Hub to change the current loaded country."

  it('stays on a page whose module covers the chosen organisation', () => {
    // Invoicing lists every organisation, so Canada keeps the page.
    expect(nextPathAfterSwitch('/invoicing/accepted', 'EB-CANADA')).toBe('/invoicing/accepted')
  })

  it('goes home from a page whose module does not have the organisation', () => {
    // s.r.o. manufactures; it has no sales pipeline and no place under Quotes.
    expect(nextPathAfterSwitch('/quotes', 'EB-SRO')).toBe('/')
    expect(nextPathAfterSwitch('/quotes/deals/123', 'EB-SRO')).toBe('/')
  })

  it('stays on a page that is not organisation-scoped at all', () => {
    expect(nextPathAfterSwitch('/', 'EB-CANADA')).toBe('/')
    expect(nextPathAfterSwitch('/profile', 'EB-SRO')).toBe('/profile')
  })

  it('never hands the route anything but a path on this site', () => {
    expect(nextPathAfterSwitch('//evil.example', 'EB-CANADA')).toBe('/')
    expect(nextPathAfterSwitch('https://evil.example/x', 'EB-CANADA')).toBe('/')
  })
})
