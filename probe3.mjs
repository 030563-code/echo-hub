import { chromium } from 'playwright'
const BASE = 'http://localhost:3005'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('pageerror', (e) => errors.push(`PAGEERROR ${page.url()} :: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE :: ${m.text()}`) })

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', process.env.E2E_USERNAME)
await page.fill('input[type="password"]', process.env.E2E_PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })

await page.goto(`${BASE}/transport`, { waitUntil: 'networkidle' })
console.log('TRANSPORT h1:', await page.locator('h1').first().innerText())
const rows = await page.locator('tbody tr').count()
console.log('TRANSPORT rows:', rows)
console.log('TRANSPORT summary line:', await page.locator('p', { hasText: /shipment/ }).first().innerText())
await page.screenshot({ path: '/tmp/t-board-1500.png', fullPage: true })
await page.setViewportSize({ width: 390, height: 900 })
await page.screenshot({ path: '/tmp/t-board-390.png', fullPage: true })
console.log('BODY scrolls sideways at 390:', await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1))
await page.setViewportSize({ width: 1500, height: 1000 })

if (rows > 0) {
  await page.locator('tbody tr').first().click()
  await page.waitForTimeout(4000)
  const panel = await page.locator('[role="dialog"]').innerText()
  console.log('--- PANEL ---')
  console.log(panel.slice(0, 700))
  await page.screenshot({ path: '/tmp/t-panel-1500.png', fullPage: false })
}

console.log('\n--- page errors ---')
console.log(errors.length === 0 ? 'NONE' : errors.join('\n'))
await browser.close()
