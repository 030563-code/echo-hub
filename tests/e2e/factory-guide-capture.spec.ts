import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { serviceClient, deletePurchaseOrdersByNotes } from './db-helpers'

/**
 * Screenshots for the Slovak guide the factory gets.
 *
 * NOT A TEST. A capture run: it drives the real factory pages through the three steps and saves a
 * picture at each one, so the guide shows the screens as they are rather than as I remember them.
 *
 * 🔴 RUN WITH NEXT_PUBLIC_HUB_ENV=staging. Confirming an order and marking it finished both send
 * mail; every one of those notifiers returns early when externalCallsDisabled() is true, and that
 * is the only thing standing between this run and a real person hearing about an order that does
 * not exist.
 *
 * Self-contained: its own auth user, grants and purchase order chain, all removed afterwards.
 */

const TAG = 'GUIDE CAPTURE FIXTURE'
const PASSWORD = 'guide-capture-passw0rd!'
const OUT = process.env.GUIDE_OUT ?? '/tmp/guide'
/** 'sk' for the factory's own copy, 'en' for the one we read. */
const LOCALE = process.env.GUIDE_LOCALE === 'en' ? 'en' : 'sk'
const sb = serviceClient()

let userId = ''
let email = ''
let parentId = ''
let orderId = ''

/**
 * Hide what belongs to the capture rather than to the guide: the staging banner, and the throwaway
 * account in the rail. A reader should see their own screen, not mine.
 */
async function tidy(page: Page) {
  await page.addStyleTag({
    content: `
      [class*="STAGING"], div:has(> span:text-is("STAGING SANDBOX")) { display: none !important; }
      [data-guide-hide] { visibility: hidden !important; }
    `,
  })
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('div, p, span'))) {
      const t = (el.textContent ?? '').trim()
      if (t.startsWith('STAGING SANDBOX') && t.length < 120) {
        ;(el as HTMLElement).style.display = 'none'
      }
    }
    // The capture account's address and the Edit profile link under it.
    for (const el of Array.from(document.querySelectorAll('p, span, a, div'))) {
      const t = (el.textContent ?? '').trim()
      if (t.startsWith('guide-capture+')) {
        const row = el.closest('div')
        if (row) (row as HTMLElement).style.visibility = 'hidden'
      }
    }
  })
}

/**
 * A numbered marker pinned over a real element.
 *
 * The element is resolved with a Playwright LOCATOR and measured outside the page, because
 * `:has-text()` is Playwright's own engine and document.querySelector has never heard of it.
 * Only plain numbers cross into evaluate().
 */
async function annotate(
  page: Page,
  marks: Array<{ at: Locator; n: number; where?: 'left' | 'right' | 'above' }>,
) {
  // 🔴 TIDY FIRST, THEN MEASURE. Hiding the staging banner shortens the page by its own height, so
  // measuring before hiding it drew every ring one banner lower than the thing it points at.
  await tidy(page)
  const boxes: Array<{ n: number; where: string; x: number; y: number; w: number; h: number }> = []
  for (const m of marks) {
    const box = await m.at.first().boundingBox()
    if (!box) continue
    boxes.push({ n: m.n, where: m.where ?? 'right', x: box.x, y: box.y, w: box.width, h: box.height })
  }

  await page.evaluate((items) => {
    document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove())
    const layer = document.createElement('div')
    layer.setAttribute('data-guide-overlay', '')
    layer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:99999;font-family:Arial,Helvetica,sans-serif'
    document.body.appendChild(layer)

    for (const item of items) {
      // boundingBox is viewport relative; the screenshot is the whole document.
      const top = item.y + window.scrollY
      const left = item.x + window.scrollX

      const ring = document.createElement('div')
      ring.style.cssText = `position:absolute;top:${top - 6}px;left:${left - 6}px;width:${item.w + 12}px;height:${item.h + 12}px;border:3px solid #FF7026;border-radius:10px;box-shadow:0 0 0 4px rgba(255,112,38,0.18)`
      layer.appendChild(ring)

      const size = 40
      const y = item.where === 'above' ? top - size - 12 : top + item.h / 2 - size / 2
      const x =
        item.where === 'left'
          ? left - size - 18
          : item.where === 'above'
            ? left + item.w - size // right-aligned, clear of the field's own label
            : left + item.w + 18
      const badge = document.createElement('div')
      badge.textContent = String(item.n)
      badge.style.cssText = `position:absolute;top:${y}px;left:${Math.max(4, x)}px;width:${size}px;height:${size}px;border-radius:50%;background:#FF7026;color:#fff;font-size:22px;font-weight:bold;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.25)`
      layer.appendChild(badge)
    }
  }, boxes)
}

async function shot(page: Page, name: string) {
  await tidy(page)
  await page.waitForTimeout(350)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
}

test.beforeAll(async () => {
  if (!sb) return
  mkdirSync(OUT, { recursive: true })

  email = `guide-capture+${Date.now()}@example.com`
  const { data: created, error: userErr } = await sb.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Výroba' },
  })
  if (userErr) throw userErr
  userId = created.user.id

  await sb.from('profiles').update({ display_name: 'Výroba', is_external: true }).eq('id', userId)
  await sb.from('user_capabilities').insert([
    { user_id: userId, capability: 'factory.view' },
    { user_id: userId, capability: 'factory.update' },
  ])

  const { data: parent } = await sb
    .from('purchase_orders')
    .insert({
      leg: 'EB_GROUP_TO_SRO', from_entity: 'EB-GROUP', to_entity: 'EB-SRO',
      status: 'in_manufacturing', fulfilment_type: 'manufacture', source: 'hub',
      requested_by: 'GUIDE', approved_by: 'GUIDE', notes: TAG, po_number: 'GUIDEPO9001',
    })
    .select('id').single()
  parentId = parent!.id

  const { data: order } = await sb
    .from('purchase_orders')
    .insert({
      leg: 'SRO_TO_SUPPLIER', from_entity: 'EB-SRO', to_entity: 'SUPPLIER',
      status: 'approved', source: 'hub', requested_by: 'GUIDE', approved_by: 'GUIDE',
      notes: TAG, po_number: 'GUIDEPO9001-1', parent_po_id: parentId,
    })
    .select('id').single()
  orderId = order!.id

  for (const poId of [parentId, orderId]) {
    await sb.from('purchase_order_lines').insert([
      { po_id: poId, sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 350 },
      { po_id: poId, sku: 'EBH8NA', product_name: 'Echo Barrier H8', product_family: 'H8', quantity: 120 },
    ])
  }

  await sb.from('po_manufacturing').insert({ po_id: orderId, sent_at: new Date().toISOString() })
})

test.afterAll(async () => {
  if (!sb) return
  if (orderId) await sb.from('stock_movements').delete().eq('ref_id', orderId)
  await sb.from('po_cargo_request').delete().eq('po_id', orderId)
  await sb.from('po_spec_document').delete().eq('po_id', orderId)
  await deletePurchaseOrdersByNotes(sb, TAG)
  if (userId) {
    await sb.from('user_capabilities').delete().eq('user_id', userId)
    await sb.from('profiles').delete().eq('id', userId)
    await sb.auth.admin.deleteUser(userId)
  }
})

test('capture the three steps', async ({ page }) => {
  test.skip(!sb, 'no service-role key in .env.local')
  test.skip(
    process.env.NEXT_PUBLIC_HUB_ENV !== 'staging',
    'refusing to run outside staging: confirming and finishing send mail',
  )
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1180, height: 900 })

  // --- sign in ------------------------------------------------------------
  await page.goto('/login')
  // The screenshot shows the address THEY will type, not the throwaway this capture signs in with.
  await page.getByPlaceholder('name@echobarrier.com').fill('sklad@bamida.sk')
  await page.getByPlaceholder('••••••••').fill(PASSWORD)
  await annotate(page, [
    { at: page.getByPlaceholder('name@echobarrier.com'), n: 1, where: 'right' },
    { at: page.getByPlaceholder('••••••••'), n: 2, where: 'right' },
    { at: page.getByRole('button', { name: /Sign In/i }), n: 3, where: 'right' },
  ])
  await shot(page, '01-login')

  await page.evaluate(() => document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove()))
  await page.getByPlaceholder('name@echobarrier.com').fill(email)
  await page.getByRole('button', { name: /Sign In/i }).click()
  await page.waitForURL((u) => new URL(u).pathname === '/factory', { timeout: 40_000 })
  await page.context().addCookies([
    { name: 'factory_lang', value: LOCALE, url: page.url() },
  ])
  await page.reload()

  // --- the list -----------------------------------------------------------
  const T = LOCALE === 'sk'
    ? { orders: 'Výroba', download: /Stiahnuť objednávku/, confirm: 'Potvrdiť objednávku',
        finished: 'Výroba dokončená', step1: 'Stiahnite si objednávku', done: /Potvrdené|Potvrdená/i,
        yes: /Áno/i,
        phoneOpen: 'Otvoriť túto stránku v telefóne', phoneTitle: 'Otvoriť v telefóne' }
    : { orders: 'Manufacturing', download: /Download purchase order/, confirm: 'Confirm purchase order',
        finished: 'Manufacturing finished', step1: 'Download the purchase order', done: /Confirmed/i,
        yes: /Yes/i,
        phoneOpen: 'Open this page on your phone', phoneTitle: 'Open on your phone' }
  await expect(page.getByRole('heading', { name: T.orders })).toBeVisible({ timeout: 20_000 })
  await annotate(page, [{ at: page.locator('table tbody tr').first(), n: 1, where: 'left' }])
  await shot(page, '02-orders-list')

  // --- the order, nothing done yet ----------------------------------------
  await page.goto(`/factory/${orderId}`)
  await expect(page.getByText(T.step1)).toBeVisible({ timeout: 20_000 })
  await annotate(page, [
    { at: page.getByRole('button', { name: T.download }), n: 1, where: 'right' },
    { at: page.locator('input[type="date"]').first(), n: 2, where: 'above' },
    { at: page.locator('input[type="date"]').nth(1), n: 3, where: 'above' },
  ])
  await shot(page, '03-steps-before')

  // --- the dates ----------------------------------------------------------
  await page.evaluate(() => document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove()))
  const dates = page.locator('input[type="date"]')
  await dates.nth(0).fill('2026-09-29')
  await dates.nth(1).fill('2026-10-17')
  await annotate(page, [
    { at: page.getByRole('button', { name: T.confirm }), n: 4, where: 'right' },
  ])
  await shot(page, '04-dates-filled')

  // --- confirmed ----------------------------------------------------------
  await page.evaluate(() => document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove()))
  await page.getByRole('button', { name: T.confirm }).click()
  await expect(page.getByText(T.done).first()).toBeVisible({ timeout: 30_000 })
  await annotate(page, [{ at: page.getByRole('button', { name: T.finished }), n: 5, where: 'right' }])
  await shot(page, '05-confirmed')

  // --- the QR code, for the guide's install page ---------------------------
  // Viewport rather than fullPage: a modal centred in the window reads as a modal, and a full-page
  // shot of a dialog over a long page is mostly the page behind it.
  await page.evaluate(() => document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove()))
  await annotate(page, [
    { at: page.getByRole('button', { name: T.phoneOpen }), n: 1, where: 'left' },
  ])
  await tidy(page)
  await page.screenshot({ path: `${OUT}/07-phone-button.png` })
  await page.evaluate(() => document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove()))
  await page.getByRole('button', { name: T.phoneOpen }).click()
  await expect(page.getByText(T.phoneTitle)).toBeVisible({ timeout: 10_000 })
  // The capture runs on localhost and the guide is read against the real Hub. Swapping the printed
  // address is the honest thing for an ILLUSTRATION: the QR itself is per page and meaningless in
  // a printed guide anyway, and localhost:3000 would send somebody hunting for a server.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="open-on-phone-url"]')
    if (el) el.textContent = 'https://hub.echobarrier.com/factory/...'
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/08-qr.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // --- finished -----------------------------------------------------------
  await page.evaluate(() => document.querySelectorAll('[data-guide-overlay]').forEach((n) => n.remove()))
  await page.getByRole('button', { name: T.finished }).first().click()
  const yes = page.getByRole('button', { name: T.yes }).first()
  if (await yes.isVisible().catch(() => false)) await yes.click()
  await page.waitForTimeout(3000)
  await shot(page, '06-finished')
})
