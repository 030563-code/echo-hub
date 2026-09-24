import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { invoicingProfile, invoicingProfileForDepot, INVOICING_LIVE_ORGS } from '@/lib/customer-invoice/invoicing-profile'
import {
  DEPOT_FROM_ADDRESSES,
  INVOICE_DEPOTS,
  KIT_SHIP_FROM,
  invoiceDepotsForOrg,
  kitShipFrom,
} from '@/lib/customer-invoice/constants'
import { buildDraftLines, type RawDealLine } from '@/lib/customer-invoice/build-draft'
import { depotsForOrg, orgForDepot, organisation } from '@/lib/organisations'
import { xeroWebhookFor } from '@/lib/xero-hub'

/**
 * Canadian invoicing, Phase 1: the module is organisation-aware for Canada up to
 * the tax step, and nothing Canadian can reach Xero or TaxJar yet. These pin the
 * profile, the depots, the kit rule and the migration's agreement with the code.
 * Every id, code and address is invented.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

const NOT_CONNECTED = 'Canadian tax is worked out by Xero. That step is not connected to the Hub yet.'

describe('Canada has an invoicing profile, with its Xero leg marked not connected', () => {
  it('is CAD, delivers in Canada, ships from Hamilton, and numbers in EBCA', () => {
    const ca = invoicingProfile('EB-CANADA')!
    expect(ca).not.toBeNull()
    expect(ca).toMatchObject({
      org: 'EB-CANADA',
      currency: 'CAD',
      country: 'CA',
      depots: ['CA-HAM'],
      accountCodeColumn: 'canada_xero_account_code',
      holdingPrefix: 'CAI',
      invoiceSeries: 'EBCA',
      checksRegistryCurrency: true,
    })
  })

  it('prices by a Xero draft, and says in one sentence that the step is not connected', () => {
    const ca = invoicingProfile('EB-CANADA')!
    expect(ca.taxEngine).toBe('xero_draft')
    expect(ca.xeroNotConnected).toBe(NOT_CONNECTED)
  })

  it('🔴 never sends our own tax amount, and names no Xero tax type it has not been given', () => {
    const ca = invoicingProfile('EB-CANADA')!
    expect(ca.sendsTaxAmount).toBe(false)
    expect(ca.xeroTaxType).toBeNull()
    expect(ca.xeroTaxTypeName).toBeNull()
  })

  it('finds Canada from its depot in any case, and nobody else from it', () => {
    expect(invoicingProfileForDepot('CA-HAM')?.org).toBe('EB-CANADA')
    expect(invoicingProfileForDepot(' ca-ham ')?.org).toBe('EB-CANADA')
    expect(invoicingProfileForDepot('EU-SK')).toBeNull()
    expect(invoicingProfileForDepot('')).toBeNull()
    expect(INVOICING_LIVE_ORGS).toEqual(['EB-USA', 'EB-CANADA', 'EB-FRANCE'])
  })

  it('leaves the USA and France connected, and each on its own currency rule', () => {
    const us = invoicingProfile('EB-USA')!
    const fr = invoicingProfile('EB-FRANCE')!
    expect(us.xeroNotConnected).toBeNull()
    expect(fr.xeroNotConnected).toBeNull()
    expect(us.checksRegistryCurrency).toBe(true)
    // The EURO sync never wrote the currency, so France is not held to it.
    expect(fr.checksRegistryCurrency).toBe(false)
    // The sentences the editor has always shown under the address, word for word.
    expect(us.deliveryAddressUse).toBe('Used to calculate US sales tax: the ship-to address, not the billing address.')
    expect(fr.deliveryAddressUse).toBe('Printed on the invoice and decides the TVA case: the ship-to address, not the billing address.')
  })
})

describe('the invoicing depots are the organisation registry\'s', () => {
  it('each profile invoices exactly its organisation\'s depots, in its currency', () => {
    for (const org of INVOICING_LIVE_ORGS) {
      const profile = invoicingProfile(org)!
      expect(profile.depots, org).toEqual(depotsForOrg(org))
      expect(profile.currency, org).toBe(organisation(org).currency)
    }
  })

  it('every invoicing depot resolves to the profile of the organisation that owns it', () => {
    for (const depot of INVOICE_DEPOTS) {
      expect(invoicingProfileForDepot(depot)?.org, depot).toBe(orgForDepot(depot))
    }
  })

  it('drops depots this module cannot invoice from', () => {
    expect(invoiceDepotsForOrg('EB-SRO')).toEqual([])
    expect(invoiceDepotsForOrg('EB-GROUP')).toEqual([])
    expect(invoiceDepotsForOrg('EB-CANADA')).toEqual(['CA-HAM'])
  })

  it('knows no Hamilton dispatch address, rather than a guessed one', () => {
    expect(DEPOT_FROM_ADDRESSES['CA-HAM']).toBeNull()
  })
})

describe('fitting kits dispatch where the database splits them', () => {
  // split_fitting_kit_lines(): Baltimore for a US deal, the deal's own depot otherwise.
  it('Baltimore for either US depot, and the deal\'s own depot anywhere else', () => {
    expect(kitShipFrom('US-BAL')).toBe(KIT_SHIP_FROM)
    expect(kitShipFrom('US-SBD')).toBe('US-BAL')
    expect(kitShipFrom('CA-HAM')).toBe('CA-HAM')
    expect(kitShipFrom('EU-FR')).toBe('EU-FR')
  })

  const kit: RawDealLine = { name: 'Fitting Kits', hs_product_id: '138783', quantity: 3, unit_price: 40 }

  it('keeps a Canadian kit at Hamilton, so the draft save does not refuse the invoice', () => {
    const lines = buildDraftLines([kit, { name: 'Echo Barrier H9', sku: 'EBH9NA', quantity: 5, unit_price: 100 }], 'CA-HAM')
    expect(lines.map((l) => [l.sku, l.ship_from_depot, l.ship_from_locked])).toEqual([
      ['HKNA', 'CA-HAM', true],
      ['BUNNA', 'CA-HAM', true],
      ['EBH9NA', 'CA-HAM', false],
    ])
  })

  it('keeps a component the database already split for a Canadian deal at Hamilton', () => {
    const hook: RawDealLine = {
      name: 'Echo Barrier Hooks', sku: 'HKNA', hs_product_id: '138783', kit_parent_line_key: 'LI-7',
      origin: 'kit_split', ship_from_depot: 'CA-HAM', quantity: 3, unit_price: 30,
    }
    const [line] = buildDraftLines([hook], 'CA-HAM')
    expect(line.ship_from_depot).toBe('CA-HAM')
    expect(line.origin).toBe('kit_split')
  })

  it('still pins a US kit to Baltimore when the barriers leave San Bernardino', () => {
    const lines = buildDraftLines([kit], 'US-SBD')
    expect(lines.map((l) => l.ship_from_depot)).toEqual(['US-BAL', 'US-BAL'])
  })
})

describe('nothing Canadian can reach Xero while the leg is not connected', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses Canada even when a webhook URL has been set, by accident or early', () => {
    vi.stubEnv('N8N_CUSTOMER_INVOICE_WEBHOOK_URL_CA', 'https://n8n.example.invalid/webhook/ca')
    // The worst case: somebody points Canada at the USA workflow's URL.
    vi.stubEnv('N8N_CUSTOMER_INVOICE_WEBHOOK_URL', 'https://n8n.example.invalid/webhook/us')
    const hook = xeroWebhookFor('EB-CANADA')
    expect(hook.ok).toBe(false)
    if (!hook.ok) expect(hook.error).toBe("Canada's Xero is not connected to the Hub yet.")
  })

  it('still hands the USA its own webhook', () => {
    vi.stubEnv('N8N_CUSTOMER_INVOICE_WEBHOOK_URL', 'https://n8n.example.invalid/webhook/us')
    vi.stubEnv('N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET', 'invented-test-secret')
    const hook = xeroWebhookFor('EB-USA')
    expect(hook).toEqual({ ok: true, url: 'https://n8n.example.invalid/webhook/us', secret: 'invented-test-secret' })
  })
})

describe('the migration and the code agree', () => {
  const sql = read('supabase/migrations/20260924230000_a_canadian_customer_invoice_can_exist.sql')

  it('widens the country, the state, the postcode and the depot, keeping the US and French branches', () => {
    expect(sql).toContain("check (delivery_country in ('US', 'FR', 'CA'))")
    expect(sql).toContain("check (ship_from_depot = any (array['US-BAL', 'US-SBD', 'EU-FR', 'CA-HAM']))")
    expect(sql).toContain("when 'US' then delivery_zip is null or delivery_zip ~ '^[0-9]{5}(-[0-9]{4})?$'")
    expect(sql).toContain("when 'FR' then delivery_zip is null or delivery_zip ~ '^[0-9]{5}$'")
    expect(sql).toContain("'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'])")
  })

  it('adds the EBCA series and leaves the live numbering function alone', () => {
    expect(sql).toContain("values ('EBCA', to_char(now() at time zone 'utc', 'YY'), 1)")
    expect(sql).not.toMatch(/create or replace function/i)
    // The branch the migration relies on, as the live function has it since France.
    expect(read('supabase/migrations/20260922230000_a_french_customer_invoice_can_exist.sql')).toContain(
      "when 'EB-CANADA' then 'EBCA'",
    )
    expect(invoicingProfile('EB-CANADA')!.invoiceSeries).toBe('EBCA')
  })

  it('can be undone, and the undo refuses once anything Canadian exists', () => {
    const down = 'supabase/migrations/rollback/20260924230000_a_canadian_customer_invoice_can_exist.down.sql'
    expect(existsSync(join(process.cwd(), down))).toBe(true)
    const undo = read(down)
    expect(undo).toContain("check (delivery_country in ('US', 'FR'))")
    expect(undo).toContain("organisation_code = 'EB-CANADA' or delivery_country = 'CA'")
    expect(undo).toContain("series = 'EBCA' and next_value > 1")
  })
})
