import { test, expect, type Page } from '@playwright/test'
import { claireCreds, login } from './helpers'

/**
 * Claire Lavoisier's Hub, walked as her. Dean, 23 Sep 2026, after adding her
 * login to .env.local: "use wisely to make sure theres no bugs."
 *
 * She holds one organisation (France), six capabilities, and is the first
 * person to hold invoicing.manage as a row rather than through super admin, so
 * every path here is one Dave's account never exercised. Read only: no invoice
 * is opened and no deal is moved. The only writes are her own session and a
 * hub_org cookie the switch route refuses her anyway.
 *
 * Every test also fails on an uncaught browser error or on the Hub's own
 * error card, because a page that renders the card has still "loaded" as far
 * as a URL check can tell.
 */
const c = claireCreds()

const ERROR_CARD = /Something went wrong|The Hub was updated/

/** The modules her capabilities open, and the ones they do not. */
const HERS = ['Quotes', 'Invoicing', 'Pricing', 'Calls']
const NOT_HERS = ['Purchase Orders', 'Bill of Materials', 'Transport', 'Invoices', 'Stock Prediction Engine', 'Stock', 'Manufacturing']

const DASHBOARD = /^https?:\/\/[^/]+\/$/

async function expectNoErrorCard(page: Page) {
  await expect(page.getByText(ERROR_CARD)).toHaveCount(0)
}

test.describe("Claire's Hub: France only, invoicing live, nothing else", () => {
  test.skip(!c, 'Set CLAIRE_EMAIL/CLAIRE_PASSWORD to walk the France persona')

  const browserErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    browserErrors.length = 0
    page.on('pageerror', (err) => browserErrors.push(err.message))
    await login(page, c!)
  })

  test.afterEach(async ({ page }) => {
    await expectNoErrorCard(page)
    expect(browserErrors, 'uncaught browser errors').toEqual([])
  })

  test('the header says France with nothing to switch to, and the rail is her four modules', async ({ page }) => {
    await expect(page.getByTestId('active-organisation')).toHaveText(/France/)
    // One organisation is a badge, not a button: there is nothing to switch to.
    await expect(page.getByRole('button', { name: /Switch organisation/ })).toHaveCount(0)

    const rail = page.locator('aside')
    for (const label of HERS) await expect(rail.getByRole('link', { name: label, exact: true }), label).toBeVisible()
    for (const label of NOT_HERS) await expect(rail.getByRole('link', { name: label, exact: true }), label).toHaveCount(0)
    // No per-module organisation lists either, for the same reason, and no
    // Operations heading anywhere: a group with nothing she can open is not shown.
    await expect(rail.getByRole('button', { name: /^Organisations for / })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Operations' })).toHaveCount(0)

    await page.screenshot({ path: test.info().outputPath('claire-dashboard.png'), fullPage: true })
  })

  test('the dashboard offers her modules and no others', async ({ page }) => {
    const main = page.getByRole('main')
    for (const label of HERS) await expect(main.getByRole('link', { name: label, exact: true }), label).toBeVisible()
    for (const label of NOT_HERS) await expect(main.getByRole('link', { name: label, exact: true }), label).toHaveCount(0)
  })

  test('Accepted Quotes is live for France: no banner, and her wording on the tabs', async ({ page }) => {
    await page.goto('/invoicing/accepted')
    await expect(page).toHaveURL(/\/invoicing\/accepted$/)
    await expect(page.getByRole('heading', { name: 'Accepted Quotes', level: 1 })).toBeVisible()
    await expect(page.getByText(/France quotes marked Quotation Accepted/)).toBeVisible()
    await expect(page.getByText(/is not set up in the Hub yet/)).toHaveCount(0)

    const nav = page.getByRole('navigation', { name: 'Invoicing' })
    await expect(nav.getByRole('link', { name: 'Invoice numbered' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'TaxJar order transaction created' })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Tax Setup' })).toBeVisible()

    // Empty today (no EURO deal has entered Quotation Accepted since the
    // cutover), a table once one has. Either way the page is whole.
    await expect(page.getByText('No accepted France quotes yet').or(page.getByRole('table')).first()).toBeVisible()

    await page.screenshot({ path: test.info().outputPath('claire-accepted.png'), fullPage: true })
  })

  test('every stage tab loads for her, and none of them talks about TaxJar or the EBUS number', async ({ page }) => {
    const tabs: Array<[string, string]> = [
      ['/invoicing/tax-calculated', 'Tax calculated'],
      ['/invoicing/filed', 'Invoice numbered'],
      ['/invoicing/documented', 'Invoice draft generated'],
      ['/invoicing/sent', 'Invoice sent'],
      ['/invoicing/completed', 'Invoice sent to Xero and attached PDF'],
    ]
    for (const [href, heading] of tabs) {
      await page.goto(href)
      await expect(page.getByRole('heading', { name: heading, level: 1 }), href).toBeVisible()
      await expect(page.getByRole('main').getByText(/TaxJar|EBUS/), href).toHaveCount(0)
      await expectNoErrorCard(page)
    }
    await page.goto('/invoicing/tax-calculated')
    await page.screenshot({ path: test.info().outputPath('claire-tax-calculated.png'), fullPage: true })
  })

  test('Tax Setup describes her tax, not the USA states', async ({ page }) => {
    await page.goto('/invoicing/tax-setup')
    await expect(page.getByRole('heading', { name: 'Tax Setup', level: 1 })).toBeVisible()
    const main = page.getByRole('main')
    await expect(main.getByText('TAX001')).toBeVisible()
    await expect(main.getByText('Echo Barrier SAS').first()).toBeVisible()
    await expect(main.getByText(/TaxJar|Sales tax states|Maryland/)).toHaveCount(0)

    await page.screenshot({ path: test.info().outputPath('claire-tax-setup.png'), fullPage: true })
  })

  test('Quotes, Pricing, Calls and her profile open, finish loading, and do not send her home', async ({ page }) => {
    test.setTimeout(120_000)
    for (const path of ['/quotes', '/pricing', '/calls', '/profile']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(new RegExp(`${path}(/|$|\\?)`))
      // "Loaded" means the skeleton is gone and the data is on screen, not that
      // the URL is right: a page passes the URL check while its list is still
      // streaming, and a screenshot of a skeleton proves nothing.
      await page.waitForLoadState('networkidle')
      await expect(page.locator('main .animate-pulse'), `${path} still loading`).toHaveCount(0, { timeout: 20_000 })
      await expect(page.getByText(/Opening your details/), path).toHaveCount(0)
      await expectNoErrorCard(page)
      await page.screenshot({ path: test.info().outputPath(`claire${path.replace(/\//g, '-')}.png`), fullPage: true })
    }
  })

  // The walk-through above runs in the machine's time zone, which only shows
  // this bug when it differs from the server's. The live server runs in UTC and
  // her browser in Paris: the Calls page formatted each call's time on both, got
  // two different texts, and React threw its hydration error (418) at her on
  // every first load. So the Calls tabs are also read from her zone, and from a
  // US one as the US office would read them. Each has to hydrate without that
  // error (the afterEach above) and then show the reader's own clock.
  for (const timezoneId of ['Europe/Paris', 'America/New_York']) {
    test.describe(`Calls read from ${timezoneId}`, () => {
      test.use({ timezoneId })

      test("the Calls tabs hydrate cleanly and show each call at the reader's own time", async ({ page }) => {
        await page.goto('/calls/log')
        await page.waitForLoadState('networkidle')
        const times = page.locator('main table time')
        const count = await times.count()
        test.info().annotations.push({ type: 'calls checked', description: String(count) })
        for (let i = 0; i < count; i++) {
          const time = times.nth(i)
          const iso = (await time.getAttribute('datetime')) ?? ''
          const clock = new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezoneId })
          await expect(time.locator('span').last(), iso).toHaveText(clock)
        }

        await page.goto('/calls/contacts')
        await page.waitForLoadState('networkidle')
        await expect(page.getByRole('heading', { name: 'Calls', level: 1 })).toBeVisible()
      })
    })
  }

  test('the modules she does not hold send her home', async ({ page }) => {
    for (const path of ['/purchase-orders', '/transport', '/mrp', '/bom', '/stock', '/invoices', '/factory']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(DASHBOARD)
    }
  })

  test('a planted USA cookie and the switch route both leave her on France', async ({ page, baseURL }) => {
    // The cookie is a preference resolved against what she holds, never an
    // authority. A forged one can only ever pick between her own organisations.
    await page.context().addCookies([{ name: 'hub_org', value: 'EB-USA', url: baseURL! }])
    await page.goto('/invoicing/accepted')
    await expect(page.getByTestId('active-organisation')).toHaveText(/France/)
    await expect(page.getByText(/France quotes marked Quotation Accepted/)).toBeVisible()
    await expect(page.getByText(/USA quotes marked/)).toHaveCount(0)

    // And the route that sets it refuses an organisation she does not hold,
    // answering exactly as it would for one that does not exist.
    await page.goto('/org/EB-USA?next=%2Fquotes')
    // The dashboard by its path. Netlify re-appends the request's query to a redirect, so the live
    // site lands on /?next=%2Fquotes where localhost lands on /, and both are the dashboard.
    await expect.poll(() => new URL(page.url()).pathname).toBe('/')
    expect(new URL(page.url()).host).toBe(new URL(baseURL!).host)
    await expect(page.getByTestId('active-organisation')).toHaveText(/France/)
  })
})
