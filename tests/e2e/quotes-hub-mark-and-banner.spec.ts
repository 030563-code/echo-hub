import { test, expect } from '@playwright/test'
import { adminCreds, claireCreds, login } from './helpers'

/**
 * Dean, 23 Sep 2026, three asks for Quotes:
 *   - an orange EH mark on each board card quoted through the Hub;
 *   - a red warning above every Quotes tab when the person signed in has open deals past their
 *     close date, by the CSO's rule;
 *   - "The + Create Deal button should be more prominent and also be in the Board tab".
 *
 * Read only. Nothing here opens a quote, submits a form or moves a deal: the one click lands on
 * the empty Create Deal form and stops.
 */

const hasToken = !!process.env.HUBSPOT_ACCESS_TOKEN

test.describe('Quotes: the EH mark and Create Deal (privileged user)', () => {
  const admin = adminCreds()
  test.skip(!admin || !hasToken, 'Set E2E_USERNAME/E2E_PASSWORD and HUBSPOT_ACCESS_TOKEN')

  test.beforeEach(async ({ page }) => {
    await login(page, admin!)
  })

  test('the USA board marks the deals quoted in the Hub, and says what the mark means', async ({ page }) => {
    await page.goto('/org/EB-USA?next=%2Fquotes%2Fboard')
    await expect.poll(() => new URL(page.url()).pathname).toBe('/quotes/board')
    await expect(page.getByText('marks a deal quoted in the Hub.')).toBeVisible()
    // Twelve open USA deals carried a published Hub quote on 23 Sep 2026, all touched inside the
    // board's default 60 days, so the all-reps USA board has marks to show.
    const marks = page.getByRole('img', { name: 'Quoted in the Echo Hub' })
    await expect(marks.first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/could not check which of these deals it quoted/)).toHaveCount(0)
    test.info().annotations.push({ type: 'EH marks on the USA board', description: String(await marks.count()) })

    // "at the bottom right of each deal": the mark sits in the card's bottom-right quarter.
    const card = page.locator('[draggable="true"]').filter({ has: marks.first() }).first()
    await card.scrollIntoViewIfNeeded()
    const [c, m] = [await card.boundingBox(), await card.getByRole('img', { name: 'Quoted in the Echo Hub' }).boundingBox()]
    expect(c && m).toBeTruthy()
    expect(m!.x).toBeGreaterThan(c!.x + c!.width / 2)
    expect(m!.y).toBeGreaterThan(c!.y + c!.height / 2)
    await card.screenshot({ path: test.info().outputPath('card-with-mark.png') })
  })

  test('Create Deal sits on the Board and on Deals, and opens the form', async ({ page }) => {
    for (const path of ['/quotes/board', '/quotes/deals']) {
      await page.goto(path)
      await expect(page.getByRole('link', { name: 'Create Deal' }), path).toBeVisible()
    }
    await page.goto('/quotes/board')
    await page.getByRole('link', { name: 'Create Deal' }).click()
    await expect(page).toHaveURL(/\/quotes\/create\/manual$/)
    await expect(page.getByRole('heading', { name: 'Create Deal', level: 1 })).toBeVisible()
  })
})

test.describe('Quotes: the past-close banner, as Claire', () => {
  const c = claireCreds()
  test.skip(!c || !hasToken, 'Set CLAIRE_EMAIL/CLAIRE_PASSWORD and HUBSPOT_ACCESS_TOKEN')

  test.beforeEach(async ({ page }) => {
    await login(page, c!)
  })

  test('the banner shows on every tab, lists her deals, and stays off a deal page', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/quotes/board')
    await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible()
    // The banner streams in after the page; wait for the stream to finish before counting it, or
    // a banner still on its way reads as no banner.
    await page.waitForLoadState('networkidle')
    const banner = page.getByTestId('past-close-banner')
    const shown = await banner.count()
    test.info().annotations.push({
      type: 'past close',
      description: shown ? await banner.locator('p').first().innerText() : 'no open deal past its close date',
    })
    test.skip(shown === 0, 'Claire has no open deal past its close date today, so there is no banner to follow')

    await expect(banner).toContainText(/of your open deals (is|are) past (its|their) close date\./)
    await page.screenshot({ path: test.info().outputPath('claire-board-banner.png'), fullPage: false })

    // Another tab: the layout is kept, so the same banner is still there.
    await page.getByRole('navigation', { name: 'Quotes' }).getByRole('link', { name: 'Sent' }).click()
    await expect(page).toHaveURL(/\/quotes\/sent/)
    await expect(banner).toBeVisible()

    // Folded by default; opening it lists deals, each to the Hub and to HubSpot.
    await banner.getByText(/^Show the/).click()
    const first = banner.getByRole('listitem').first()
    await expect(first).toBeVisible()
    await expect(first.getByRole('link').first()).toHaveAttribute('href', /^\/quotes\/deals\/\d+$/)
    await expect(first.getByRole('link', { name: /Change the date in HubSpot/ })).toHaveAttribute('href', /app\.hubspot\.com\/contacts\/\d+\/record\/0-3\/\d+$/)
    await page.screenshot({ path: test.info().outputPath('claire-sent-banner-open.png'), fullPage: false })

    // A deal page is not a tab: the banner steps aside there.
    await first.getByRole('link').first().click()
    await expect(page).toHaveURL(/\/quotes\/deals\/\d+$/)
    await expect(banner).toHaveCount(0)
  })
})
