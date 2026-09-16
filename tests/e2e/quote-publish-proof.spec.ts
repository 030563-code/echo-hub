import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { adminCreds, login } from './helpers'
import { serviceClient } from './db-helpers'

/**
 * The whole quote, end to end, against the live HubSpot portal, with proof.
 *
 * Dean, 15 Sep 2026, after Jillian's first real quote through the Hub went out
 * with the fitting kit split in two, the list price with an $80 discount, a
 * SKU column and an Image column: "I also want a full E2E test with proof of
 * screenshot etc then delete the entire test deal afterwards."
 *
 * 16 Sep 2026, having seen that quote as Jillian sent it: "the sku is fine in
 * the quote." So the quote is back on her own "Jillian USA" template, whose SKU
 * and Image columns are fixed in the template and render for every line. The
 * kit stays one line and no discount property is ever sent; those two still
 * hold below.
 *
 * So this spec creates its own company, contact and deal, builds and PUBLISHES
 * a quote through the real UI as the admin persona, screenshots every step,
 * reads the result back through the HubSpot API and the customer's own page,
 * and then archives every HubSpot object it made and deletes every Hub row.
 * It publishes a real quote, so it only runs when asked: E2E_PUBLISH_PROOF=1.
 * Screenshots go to E2E_PROOF_DIR (default test-results/proof).
 */

const RUN = process.env.E2E_PUBLISH_PROOF === '1'
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN
const creds = adminCreds()
const PROOF_DIR = process.env.E2E_PROOF_DIR ?? 'test-results/proof'

const USA_SALES = 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc'
const QUOTE_REQUEST_STAGE = '3f5e750b-c1cb-46b6-aa8e-cbed58d0b94c'
const JILLIAN_USA_TEMPLATE = '454422093232'
const FITTING_KIT_PRODUCT_IDS = ['57786096', '138783', '1640211461']
const LINE_ITEM_PROPS = ['name', 'hs_sku', 'price', 'quantity', 'amount', 'discount', 'hs_discount_percentage', 'hs_product_id']

/**
 * HubSpot's response shape differs per endpoint and this spec walks five of
 * them, so the body is typed loosely on purpose and every read below asserts
 * what it expects. Named rather than inline `any` so the looseness is one
 * declaration with a reason, not a habit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HubSpotBody = any

async function hs(method: string, path: string, body?: unknown): Promise<{ status: number; json: HubSpotBody }> {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: HubSpotBody = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

async function lineItemsOf(objectType: 'quotes' | 'deals', id: string) {
  const assoc = await hs('GET', `/crm/v4/objects/${objectType}/${id}/associations/line_items`)
  const ids = (assoc.json?.results ?? []).map((r: { toObjectId: string | number }) => String(r.toObjectId))
  if (ids.length === 0) return [] as { id: string; properties: Record<string, string | null> }[]
  const read = await hs('POST', '/crm/v3/objects/line_items/batch/read', { properties: LINE_ITEM_PROPS, inputs: ids.map((i: string) => ({ id: i })) })
  return (read.json?.results ?? []) as { id: string; properties: Record<string, string | null> }[]
}

const fx: { companyId?: string; contactId?: string; dealId?: string; quoteId?: string; quoteLink?: string; lineItemIds: string[] } = { lineItemIds: [] }
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, name), fullPage: true })

/** Open the n-th select on the page (Radix renders each trigger as a combobox) and choose an option. */
async function pick(page: Page, combobox: ReturnType<Page['getByRole']>, option: RegExp | string) {
  await combobox.click({ timeout: 20_000 })
  await page.getByRole('option', { name: option }).first().click({ timeout: 20_000 })
}

test.describe.serial('quote publish proof', () => {
  test.skip(!RUN || !TOKEN || !creds, 'Set E2E_PUBLISH_PROOF=1, HUBSPOT_ACCESS_TOKEN and E2E_USERNAME/PASSWORD to run; it publishes a real quote')
  test.setTimeout(240_000)

  test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) await page.screenshot({ path: join(PROOF_DIR, 'failure.png'), fullPage: true }).catch(() => {})
  })

  test.beforeAll(async () => {
    mkdirSync(PROOF_DIR, { recursive: true })
    const stamp = Date.now()
    const company = await hs('POST', '/crm/v3/objects/companies', { properties: { name: `E2E PROOF Co ${stamp} (delete me)`, domain: `e2e-proof-${stamp}.example.com` } })
    expect(company.status, JSON.stringify(company.json)).toBe(201)
    fx.companyId = String(company.json.id)
    const contact = await hs('POST', '/crm/v3/objects/contacts', {
      properties: { email: `e2e.proof.${stamp}@example.com`, firstname: 'E2E', lastname: `Proof ${stamp} (delete me)` },
      associations: [{ to: { id: fx.companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }] }],
    })
    expect(contact.status, JSON.stringify(contact.json)).toBe(201)
    fx.contactId = String(contact.json.id)
    // The admin persona's own HubSpot seat, so the deal reads as theirs.
    const owner = await hs('GET', `/crm/v3/owners/?email=${encodeURIComponent(creds!.email)}&limit=1`)
    const ownerId = owner.json?.results?.[0]?.id ? String(owner.json.results[0].id) : null
    const deal = await hs('POST', '/crm/v3/objects/deals', {
      properties: {
        dealname: `E2E PROOF ${stamp} fitting kit quote (delete me)`,
        pipeline: USA_SALES,
        dealstage: QUOTE_REQUEST_STAGE,
        deal_currency_code: 'USD',
        ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
      },
      associations: [
        { to: { id: fx.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
        { to: { id: fx.companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }] },
      ],
    })
    expect(deal.status, JSON.stringify(deal.json)).toBe(201)
    fx.dealId = String(deal.json.id)
  })

  test.afterAll(async () => {
    // Leaves first: quote, its line items, the deal's line items, the deal,
    // the contact, the company. Then every Hub row that names the deal.
    const gone: string[] = []
    const archive = async (type: string, id?: string) => {
      if (!id) return
      const r = await hs('DELETE', `/crm/v3/objects/${type}/${id}`)
      gone.push(`${type}/${id}:${r.status}`)
    }
    if (fx.dealId) {
      for (const li of await lineItemsOf('deals', fx.dealId)) await archive('line_items', li.id)
    }
    if (fx.quoteId) {
      for (const li of await lineItemsOf('quotes', fx.quoteId)) await archive('line_items', li.id)
      await archive('quotes', fx.quoteId)
    }
    await archive('deals', fx.dealId)
    await archive('contacts', fx.contactId)
    await archive('companies', fx.companyId)
    const sb = serviceClient()
    if (sb && fx.dealId) {
      const dq = await sb.from('deal_quotes').delete().eq('hubspot_deal_id', fx.dealId).select('id')
      const dr = await sb.from('deals_registry').delete().eq('hubspot_deal_id', fx.dealId).select('id')
      const ps = await sb.from('user_page_state').delete().like('page_key', `quote-builder:${fx.dealId}%`).select('page_key')
      gone.push(`deal_quotes:${dq.data?.length ?? 0}`, `deals_registry:${dr.data?.length ?? 0}`, `user_page_state:${ps.data?.length ?? 0}`)
    }
    console.log('CLEANUP', gone.join(' '))
  })

  test('the quote a customer sees is the quote Jillian would have made by hand', async ({ page, context }) => {
    await login(page, creds!)
    await page.goto(`/quotes/create/${fx.dealId}`)
    await expect(page.getByText('Quote Setup')).toBeVisible({ timeout: 30_000 })

    // Setup: sold direct, from Baltimore, on the US template, any win probability.
    // The dialog's labels repeat the placeholders, so the selects are found by
    // role. The template options are the profile's template KEYS ("US"), not
    // the pipeline labels.
    const dialog = page.getByRole('dialog').first()
    const combos = dialog.getByRole('combobox')
    await pick(page, combos.nth(0), 'Echo Barrier direct')
    await pick(page, combos.nth(1), /US Baltimore/)
    await pick(page, combos.nth(2), /^US$/)
    await pick(page, combos.nth(3), /.+/)
    await shot(page, '01-quote-setup.png')
    await page.getByRole('button', { name: /Start Quote/ }).click()
    await expect(page.getByPlaceholder('Search products...')).toBeVisible({ timeout: 30_000 })

    // The H9 at its list price: the customer must see 245, not 325 less 80.
    // The product select is the combobox beside the search box: it shows the
    // placeholder before a pick and "Name ($price)" after one.
    const productSelect = page.getByRole('combobox').filter({ hasText: /Select Product\.\.\.|\(\$/ }).first()
    await page.getByPlaceholder('Search products...').fill('Echo Barrier H9')
    await page.waitForTimeout(1200)
    await productSelect.click({ timeout: 20_000 })
    await page.getByRole('option', { name: /^Echo Barrier H9 \(/ }).first().click({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Add product' }).click()

    // The fitting kit, as ONE line. This is the product the builder hid.
    await page.getByPlaceholder('Search products...').fill('Fitting')
    await page.waitForTimeout(1200)
    await productSelect.click({ timeout: 20_000 })
    const kitOptions = page.getByRole('option', { name: /Fitting Kit/ })
    await expect(kitOptions.first()).toBeVisible({ timeout: 20_000 })
    // A viewport-sized shot: a full-page one resizes the window and closes the list.
    await page.screenshot({ path: join(PROOF_DIR, '02-fitting-kits-offered.png') })
    if (!(await kitOptions.first().isVisible())) await productSelect.click({ timeout: 20_000 })
    await page.getByRole('option', { name: /^Fitting Kits \(/ }).first().click({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Add product' }).click()

    const quantities = page.getByLabel('Quantity')
    await expect(quantities).toHaveCount(2, { timeout: 20_000 })
    await quantities.nth(0).fill('10', { timeout: 20_000 })
    await quantities.nth(1).fill('10', { timeout: 20_000 })
    // The kit has no list price, so the rep names it; the only "Unit price"
    // input on the page is that line's (a list line shows its price as text and
    // takes the charged price in "Unit price charged"). HubSpot's placeholder is $1.
    const kitPrice = page.getByLabel('Unit price', { exact: true })
    await expect(kitPrice).toHaveCount(1, { timeout: 20_000 })
    await kitPrice.fill('4.00', { timeout: 20_000 })
    await quantities.nth(1).blur()
    await shot(page, '03-cart-h9-and-fitting-kit.png')

    await page.getByRole('button', { name: 'Publish quote in HubSpot' }).click()
    const openQuote = page.getByRole('link', { name: /Open quote/ }).or(page.locator('a', { has: page.getByRole('button', { name: /Open quote/ }) }))
    await expect(openQuote.first()).toBeVisible({ timeout: 120_000 })
    await shot(page, '04-published-panel.png')

    const dealLink = page.locator('a', { has: page.getByRole('button', { name: 'Deal in HubSpot' }) }).first()
    await expect(dealLink).toHaveAttribute('href', new RegExp(`/record/0-3/${fx.dealId}$`))
    const quoteLink = await page.locator('a', { has: page.getByRole('button', { name: 'Open quote' }) }).first().getAttribute('href')
    expect(quoteLink, 'the customer link').toMatch(/^https:\/\//)
    fx.quoteLink = quoteLink!

    // What HubSpot holds.
    const dealRead = await hs('GET', `/crm/v3/objects/deals/${fx.dealId}?associations=quotes`)
    fx.quoteId = String(dealRead.json.associations?.quotes?.results?.[0]?.id ?? '')
    expect(fx.quoteId, 'a quote on the deal').not.toBe('')
    const quote = await hs('GET', `/crm/v3/objects/quotes/${fx.quoteId}?properties=hs_status,hs_quote_link,hs_logo_url,hs_primary_color,hs_quote_owner_id,hs_sender_company_name&associations=quote_template`)
    expect(quote.json.properties.hs_status).toBe('APPROVAL_NOT_NEEDED')
    expect(String(quote.json.associations?.['quote templates']?.results?.[0]?.id ?? quote.json.associations?.quote_template?.results?.[0]?.id)).toBe(JILLIAN_USA_TEMPLATE)
    expect(quote.json.properties.hs_logo_url).toMatch(/^https:\/\//)
    expect(quote.json.properties.hs_primary_color).toBe('#005843')
    expect(quote.json.properties.hs_sender_company_name).toBe('Echo Barrier Group')

    const quoteLines = await lineItemsOf('quotes', fx.quoteId)
    expect(quoteLines).toHaveLength(2)
    for (const li of quoteLines) {
      expect(li.properties.hs_discount_percentage, `${li.properties.name} percentage`).toBeNull()
      expect(Number(li.properties.discount ?? 0), `${li.properties.name} cash discount`).toBe(0)
    }
    const h9 = quoteLines.find((l) => l.properties.hs_sku === 'EBH9NA')!
    expect(Number(h9.properties.price)).toBe(245)
    const kit = quoteLines.find((l) => FITTING_KIT_PRODUCT_IDS.includes(String(l.properties.hs_product_id)))!
    expect(kit.properties.name).toMatch(/Fitting Kit/)
    expect(Number(kit.properties.price)).toBe(4)
    expect(quoteLines.some((l) => ['HKNA', 'BUNNA'].includes(String(l.properties.hs_sku)))).toBe(false)

    const dealLines = await lineItemsOf('deals', fx.dealId!)
    expect(dealLines).toHaveLength(2)
    expect(dealLines.every((l) => (l.properties.hs_discount_percentage ?? null) === null && Number(l.properties.discount ?? 0) === 0)).toBe(true)

    // The customer's page, as the customer opens it.
    const customer = await context.newPage()
    await customer.goto(fx.quoteLink!)
    await expect(customer.getByText(/Fitting Kit/).first()).toBeVisible({ timeout: 30_000 })
    const headers = (await customer.locator('th').allTextContents()).map((h) => h.trim())
    // Her template's columns, fixed in the template. Both headers prove it is
    // the Jillian USA template the customer is looking at.
    expect(headers).toContain('SKU')
    expect(headers).toContain('Image')
    await expect(customer.getByText(/discount/i)).toHaveCount(0)
    // The SKU is meant to show now (Dean, 16 Sep 2026).
    await expect(customer.getByText('EBH9NA').first()).toBeVisible()
    await expect(customer.getByText('$245.00').first()).toBeVisible()
    await expect(customer.getByText('$325.00')).toHaveCount(0)
    await shot(customer, '05-customer-quote-page.png')
    await customer.close()

    // The deal page in the Hub: the link goes to the deal, the quote's own link sits beside it, and the row has the link stored.
    await page.goto(`/quotes/deals/${fx.dealId}`)
    const cardDeal = page.locator('a', { has: page.getByRole('button', { name: 'Deal in HubSpot' }) }).first()
    await expect(cardDeal).toHaveAttribute('href', new RegExp(`/record/0-3/${fx.dealId}$`), { timeout: 30_000 })
    await shot(page, '06-deal-page-quote-card.png')
    const sb = serviceClient()
    if (sb) {
      const { data } = await sb.from('deal_quotes').select('quote_link, status, hubspot_quote_id').eq('hubspot_deal_id', fx.dealId!).maybeSingle()
      expect(data?.status).toBe('published')
      expect(data?.quote_link).toBe(fx.quoteLink)
      // The split lives where it belongs: the registry that feeds the invoice and Xero.
      const { data: reg } = await sb.from('deals_registry').select('line_items_raw').eq('hubspot_deal_id', fx.dealId!).maybeSingle()
      const skus = ((reg?.line_items_raw ?? []) as { sku?: string }[]).map((l) => l.sku)
      expect(skus).toEqual(expect.arrayContaining(['HKNA', 'BUNNA']))
    }
  })
})
