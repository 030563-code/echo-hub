import { test, expect, type Page } from '@playwright/test'
import { claireCreds, daveCreds, login } from './helpers'

/**
 * Dean, 23 Sep 2026: Nippon Express invoices "pull through to a new tab maybe under transport where
 * only Dave can see it. And it prefills what we need to fill in the same as it currently is under
 * Bills in Xero. The invoices should have the Invoice Number as a link to which shipment it is."
 *
 * Read only: it opens pages and never presses Approve. Needs the three sample bills in the table
 * (scripts/customs-seed-samples.local.ts, or the history run).
 */

/** The page itself never scrolls sideways; a wide table scrolls inside its own box. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('Customs, as Dave', () => {
  const dave = daveCreds()
  test.skip(!dave, 'Set DAVE_EMAIL/DAVE_PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, dave!)
  })

  test('the Customs tab lists the invoices, each number linking to its shipment', async ({ page }) => {
    await page.goto('/transport')
    const tabs = page.getByRole('navigation', { name: 'Transport' })
    await expect(tabs.getByRole('link', { name: 'Shipments' })).toBeVisible()
    await tabs.getByRole('link', { name: 'Customs' }).click()
    // A cold dev server compiles the page on first visit, which can take a while.
    await expect(page).toHaveURL(/\/transport\/customs$/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Customs', level: 1 })).toBeVisible()

    const row = page.getByRole('row').filter({ hasText: '26NEU-12G-D1518' })
    await expect(row.getByRole('link', { name: '26NEU-12G-D1518' })).toHaveAttribute('href', '/transport/242167963')
    await expect(row).toContainText('Adds up')
    await expect(row).toContainText('Paid')
    await expect(row).toContainText('$6,402.10')
    // The figures Dave reads first are on screen without scrolling the table.
    await expect(row.getByText('$6,402.10')).toBeInViewport()
    await expect(row.getByText('Paid')).toBeInViewport()
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('customs-list.png'), fullPage: true })
  })

  test('a bill shows the entry checked line by line and the Xero bill prefilled', async ({ page }) => {
    await page.goto('/transport/customs')
    await page.getByRole('row').filter({ hasText: '26NEU-12G-D0806' }).getByRole('link', { name: 'Open' }).click()
    await expect(page.getByRole('heading', { name: '26NEU-12G-D0806', level: 1 })).toBeVisible()

    // The entry: the frames at Section 232, the rule it was checked against.
    await expect(page.getByText('9903.82.02 50.00%')).toBeVisible()
    await expect(page.getByText(/Expected 55\.7%/)).toBeVisible()

    // The bill for Xero, coded the way the Group invoice is, and exam and drayage on their own lines.
    const bill = page.locator('section').filter({ has: page.getByRole('heading', { name: 'The bill for Xero' }) })
    await expect(bill).toContainText('Nippon Express USA , Inc')
    await expect(bill).toContainText('07-0154')
    await expect(bill).toContainText('07-0153')
    await expect(bill.getByRole('row').filter({ hasText: 'Container drayage' })).toContainText('07-5232')
    await expect(bill).toContainText('$16,560.66')
    // And what Dave actually keyed, for comparison.
    await expect(bill).toContainText('As it stands in Xero')
    await expect(bill).toContainText('Examoination fee')

    // Nippon's capitals written normally, initials kept.
    const charges = page.locator('section').filter({ has: page.getByRole('heading', { name: "Nippon Express's charges" }) })
    await expect(charges).toContainText('ISF filing charge')
    // A long reference wraps in its own column instead of running into the next one.
    const maker = page.getByText('GBECHBAR118BUR')
    expect(await maker.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
    await expectNoSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath('customs-bill.png'), fullPage: true })
  })

  test('the shipment shows its duty: the real figure once invoiced, an estimate before', async ({ page }) => {
    await page.goto('/transport/242167963')
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'US duty and fees' }) })
    await expect(card.getByRole('link', { name: '26NEU-12G-D1518' })).toBeVisible()
    await expect(card).toContainText('$6,002.10')
    await page.screenshot({ path: test.info().outputPath('shipment-actual.png'), fullPage: true })

    // 244498887 is on its way to Baltimore, booked at 79,465.63 USD from Slovakia.
    await page.goto('/transport/244498887')
    const estimate = page.locator('section').filter({ has: page.getByRole('heading', { name: 'US duty and fees' }) })
    await expect(estimate).toContainText('An estimate until Nippon Express')
    await expect(estimate).toContainText('10% duty on $79,466 (the $79,465.63 booked with Cargo Partner')
    await expect(estimate).toContainText('$7,946.60')
    await page.screenshot({ path: test.info().outputPath('shipment-estimate.png'), fullPage: true })
  })
})

test.describe('Customs, as someone else', () => {
  const claire = claireCreds()
  test.skip(!claire, 'Set CLAIRE_EMAIL/CLAIRE_PASSWORD')

  test('is not there for them: no tab, and the page sends them away', async ({ page }) => {
    await login(page, claire!)
    await page.goto('/transport/customs')
    await expect(page).not.toHaveURL(/\/transport\/customs/)
    await expect(page.getByRole('heading', { name: 'Customs', level: 1 })).toHaveCount(0)
  })
})
