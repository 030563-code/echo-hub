import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { adminCreds, login } from './helpers'
import { serviceClient, deletePurchaseOrdersByNotes } from './db-helpers'

/**
 * The manufacturer's own login, end to end.
 *
 * Dean, 16 Sep 2026, gave the factory a Hub account with exactly two tabs. Two
 * things are being proved here and they are different in kind.
 *
 * WHAT THEY CAN DO: the three steps on an order, in order, and the fact that
 * Confirm does nothing without both dates.
 *
 * WHAT THEY CANNOT REACH: not just "the page is not in the sidebar", but that
 * the account's own token, used directly against PostgREST the way anybody with
 * the browser bundle could, returns nothing. A nav test proves the UI hides a
 * link. This proves the database refuses the read, which is the part that
 * matters when the account belongs to another company.
 *
 * Self-contained: it makes its own auth user, profile, grants and purchase
 * order chain, and removes all of it afterwards.
 */

const TAG = 'E2E FACTORY FIXTURE'
const PASSWORD = 'e2e-factory-passw0rd!'
const sb = serviceClient()
const admin = adminCreds()

let userId = ''
let email = ''
let parentId = ''
let orderId = ''
let orderNumber = ''

/** The factory persona's own login. The shared helper waits for '/', which they never see. */
async function loginFactory(page: Page) {
  await page.goto('/login')
  await page.getByPlaceholder('name@echobarrier.com').fill(email)
  await page.getByPlaceholder('••••••••').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((u) => new URL(u).pathname === '/factory', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Manufacturing' })).toBeVisible({ timeout: 15_000 })
}

test.beforeAll(async () => {
  if (!sb) return

  email = `e2e-factory+${Date.now()}@example.com`
  const { data: created, error: userErr } = await sb.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Factory (e2e)' },
  })
  if (userErr) throw userErr
  userId = created.user.id

  // handle_new_user() already made the profile row from the metadata, so this
  // is an update. Inserting would hit the primary key.
  const { error: profileErr } = await sb
    .from('profiles')
    .update({ display_name: 'Factory (e2e)', is_external: true })
    .eq('id', userId)
  if (profileErr) throw profileErr

  const { error: capErr } = await sb.from('user_capabilities').insert([
    { user_id: userId, capability: 'factory.view' },
    { user_id: userId, capability: 'factory.update' },
  ])
  if (capErr) throw capErr
  // No user_organisations row, on purpose: the factory is not one of the seven.

  // A real chain. The parent carries the bill of materials the downloadable
  // document is built from, so the download step is not a special case.
  const { data: parent, error: parentErr } = await sb
    .from('purchase_orders')
    .insert({
      leg: 'EB_GROUP_TO_SRO',
      from_entity: 'EB-GROUP',
      to_entity: 'EB-SRO',
      status: 'in_manufacturing',
      fulfilment_type: 'manufacture',
      source: 'hub',
      requested_by: 'E2E',
      approved_by: 'E2E',
      notes: TAG,
      po_number: 'E2EPO26007',
    })
    .select('id')
    .single()
  if (parentErr) throw parentErr
  parentId = parent.id

  const { data: order, error: orderErr } = await sb
    .from('purchase_orders')
    .insert({
      leg: 'SRO_TO_SUPPLIER',
      from_entity: 'EB-SRO',
      to_entity: 'SUPPLIER',
      status: 'approved',
      source: 'hub',
      requested_by: 'E2E',
      approved_by: 'E2E',
      notes: TAG,
      po_number: 'E2EPO26008',
      parent_po_id: parentId,
    })
    .select('id, po_number')
    .single()
  if (orderErr) throw orderErr
  orderId = order.id
  orderNumber = order.po_number

  for (const poId of [parentId, orderId]) {
    const { error: lineErr } = await sb.from('purchase_order_lines').insert({
      po_id: poId,
      sku: 'EBH9NA',
      product_name: 'Echo Barrier H9',
      product_family: 'H9',
      quantity: 20,
    })
    if (lineErr) throw lineErr
  }

  // Sent: which is the moment it becomes visible to them.
  const { error: mErr } = await sb
    .from('po_manufacturing')
    .insert({ po_id: orderId, sent_at: new Date().toISOString() })
  if (mErr) throw mErr
})

test.afterAll(async () => {
  if (!sb) return
  // Finishing writes stock movements at EB-SRO. Left behind they are phantom
  // units in a live ledger, so they go before the orders they point at.
  if (orderId) await sb.from('stock_movements').delete().eq('ref_id', orderId)
  await deletePurchaseOrdersByNotes(sb, TAG)
  if (userId) {
    await sb.from('user_capabilities').delete().eq('user_id', userId)
    await sb.from('profiles').delete().eq('id', userId)
    await sb.auth.admin.deleteUser(userId)
  }
})

test.beforeEach(async () => {
  test.skip(!sb, 'no service-role key in .env.local')
  // Confirming and finishing both send mail. With the override on that is the
  // tester; without it, a real person hears about an order that does not exist.
  test.skip(
    !process.env.HUB_EMAIL_TEST_RECIPIENT,
    'HUB_EMAIL_TEST_RECIPIENT is not set: confirming would email the real recipient',
  )
})

test('signing in lands on Manufacturing, with two tabs and nothing else', async ({ page }) => {
  await loginFactory(page)

  const nav = page.locator('aside nav')
  await expect(nav.getByRole('link', { name: 'Manufacturing', exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Stock', exact: true })).toBeVisible()
  await expect(nav.getByRole('link')).toHaveCount(2)

  for (const hidden of ['Dashboard', 'Quotes', 'Purchase Orders', 'Warehousing/Stock', 'Invoicing', 'Pricing']) {
    await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0)
  }
  // They hold no organisation, so there is nothing to badge.
  await expect(page.getByTestId('active-organisation')).toHaveCount(0)
})

test('the order is listed, and opens with no price and no name on it', async ({ page }) => {
  await loginFactory(page)
  await expect(page.getByRole('link', { name: orderNumber })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Awaiting your confirmation').first()).toBeVisible()

  // Wait for the navigation the click starts, rather than for what the next
  // page renders. The table re-renders once when its saved view loads, and a
  // click that lands in that frame is swallowed with no error: the run then
  // fails 20 seconds later on a heading that was never going to appear.
  await Promise.all([
    page.waitForURL(/\/factory\/[0-9a-f-]{36}$/, { timeout: 20_000 }),
    page.getByRole('link', { name: orderNumber }).click(),
  ])
  await expect(page.getByRole('heading', { name: `Purchase order ${orderNumber}` })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('columnheader', { name: 'Product' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Quantity' })).toBeVisible()
  await expect(page.getByText('Echo Barrier H9')).toBeVisible()
  // Nothing about money, and nothing naming the manufacturer.
  await expect(page.getByText(/unit price|€|EUR|bamida/i)).toHaveCount(0)
  // Our internal product code is not their business either.
  await expect(page.getByText('EBH9NA')).toHaveCount(0)
})

test('Confirm needs both dates, then records the confirmation and emails it', async ({ page }) => {
  test.setTimeout(90_000)
  await loginFactory(page)
  await page.goto(`/factory/${orderId}`)

  const confirm = page.getByRole('button', { name: 'Confirm purchase order' })
  await expect(confirm).toBeDisabled({ timeout: 20_000 })

  // One date is not enough: this is the whole point of the step.
  await page.locator('input[type="date"]').nth(0).fill('2026-09-20')
  await expect(confirm).toBeDisabled()

  // Manufacturing finished is not offered until the order is confirmed.
  await expect(page.getByText('Confirm the purchase order first, with your estimated dates.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Manufacturing finished' })).toHaveCount(0)

  await page.locator('input[type="date"]').nth(1).fill('2026-10-04')
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(page.getByText(/Confirmed on/)).toBeVisible({ timeout: 30_000 })

  const { data: row } = await sb!
    .from('po_manufacturing')
    .select('confirmed_at, confirmed_by_uid, est_start, est_finish, confirmation_emailed_at')
    .eq('po_id', orderId)
    .single()
  expect(row!.confirmed_at).not.toBeNull()
  expect(row!.confirmed_by_uid).toBe(userId)
  expect(row!.est_start).toBe('2026-09-20')
  expect(row!.est_finish).toBe('2026-10-04')
  expect(row!.confirmation_emailed_at).not.toBeNull()
})

test('Manufacturing finished is one press, and it is what tells us to pay', async ({ page }) => {
  test.setTimeout(90_000)
  await loginFactory(page)
  await page.goto(`/factory/${orderId}`)

  // The reason it matters is on the button, not buried.
  await expect(
    page.getByText('We can only pay an invoice once its order is marked finished here'),
  ).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Manufacturing finished' }).click()
  await page.getByRole('button', { name: 'Yes, it is finished' }).click()
  await expect(page.getByText(/You marked this order finished on/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Manufacturing finished' })).toHaveCount(0)

  const { data: row } = await sb!
    .from('po_manufacturing')
    .select('finished_at, finished_by_uid')
    .eq('po_id', orderId)
    .single()
  expect(row!.finished_at).not.toBeNull()
  expect(row!.finished_by_uid).toBe(userId)

  // And the SRO leg stops claiming the barriers are still being made.
  const { data: parent } = await sb!.from('purchase_orders').select('status').eq('id', parentId).single()
  expect(parent!.status).toBe('ready_for_shipment')
})

test('the stock tab shows their feed, and never our ledger', async ({ page }) => {
  await loginFactory(page)
  await page.goto('/factory/stock')
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible({ timeout: 20_000 })
  for (const header of ['Code', 'Item', 'Quantity', 'Unit', 'Status', 'Updated']) {
    await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
  }
  await expect(page.getByText(/bamida/i)).toHaveCount(0)
  // A depot warehouse code would mean our ledger had leaked into their tab.
  await expect(page.getByText(/US-BAL|CA-HAM|EB-SRO/)).toHaveCount(0)
})

test('every other module sends them back to their own tab', async ({ page }) => {
  await loginFactory(page)
  for (const forbidden of ['/purchase-orders', '/stock', '/quotes', '/invoicing', '/mrp']) {
    await page.goto(forbidden)
    await expect(page).toHaveURL(/\/factory$/, { timeout: 20_000 })
  }
})

test('their own access token reads nothing but their feed', async () => {
  // The part a nav assertion cannot reach. Anyone holding a Hub session also
  // holds the anon key out of the browser bundle, so this is exactly what the
  // account could do from a console.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const asFactory: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: session, error: signInErr } = await asFactory.auth.signInWithPassword({
    email,
    password: PASSWORD,
  })
  expect(signInErr).toBeNull()
  expect(session.session).not.toBeNull()

  for (const table of [
    'warehouse_stock_levels',
    'purchase_orders',
    'product_code_master',
    'account_registry',
    'shipments',
    'mrp_demand_events',
    'entities',
  ]) {
    const { data } = await asFactory.from(table).select('*').limit(1)
    expect(data ?? [], `${table} should be empty for the factory`).toEqual([])
  }

  // Their own material feed is the exception, and the only one.
  const { data: feed } = await asFactory.from('bamida_material_stock').select('ns_number').limit(1)
  expect(feed?.length).toBe(1)

  // The Xero item-code master used to be writable by anybody signed in.
  const { error: writeErr } = await asFactory
    .from('product_code_master')
    .update({ is_active: true })
    .eq('internal_sku', '__e2e_never_matches__')
  expect(writeErr).not.toBeNull()

  // And a quote number is not theirs to burn.
  const { error: rpcErr } = await asFactory.rpc('get_next_quote_id')
  expect(rpcErr).not.toBeNull()

  await asFactory.auth.signOut()
})

test('an admin still sees the Factory group and can open it', async ({ page }) => {
  test.skip(!admin, 'no admin creds in .env.local')
  await login(page, admin!)
  await expect(page.locator('aside nav').getByRole('link', { name: 'Manufacturing', exact: true })).toBeVisible()
  await page.goto('/factory')
  await expect(page.getByRole('heading', { name: 'Manufacturing' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('link', { name: orderNumber })).toBeVisible()
})
