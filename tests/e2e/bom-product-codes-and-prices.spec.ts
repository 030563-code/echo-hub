import { test, expect, type Page } from '@playwright/test'
import { daveCreds, jurajCreds, login, martinCreds, type Creds } from './helpers'

/**
 * The BOM page's two new editors, as the people who use them.
 *
 * Juraj and Martin (the s.r.o.'s operations login) hold bom.edit and cost.view
 * as real rows rather than through super admin, which makes them the check
 * that the page shows properly for its users. Nothing is saved under their
 * names: those tests open, type and put back, and every confirm is dismissed.
 *
 * The one save round trip runs as the E2E account, on GenExtension: no product
 * code is costed as it, so no order can freeze the test price in between. It
 * reads the price off the page and hands it straight back, so no real figure
 * lives in this file.
 */

test.describe.configure({ mode: 'serial' })

async function openTab(page: Page, name: RegExp) {
  await page.goto('/bom')
  await page.getByRole('button', { name }).click()
}

async function checkProductCodes(page: Page) {
  await openTab(page, /^Product codes/)
  await expect(page.getByRole('columnheader', { name: 'Costed as' })).toBeVisible()

  // The two codes that had no bill of materials now find one, whichever H9X
  // roll width somebody settles on.
  const h9x = page.getByLabel('Model EBH9X is costed as')
  await expect(h9x).toBeEnabled()
  await expect(h9x).toHaveValue(/^H9X /)
  const dbrt = page.getByLabel('Model DBRT is costed as')
  await expect(dbrt).not.toHaveValue('')
  for (const sku of ['EBH9X', 'DBRT']) {
    await expect(page.getByRole('row').filter({ hasText: sku }).first().getByText('Found', { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('row').filter({ hasText: 'EBH9X' }).first().getByText(/^Chosen by/)).toBeVisible()
  expect(await h9x.locator('option').count()).toBeGreaterThan(5)
}

async function checkBamidaPricesTyping(page: Page) {
  await openTab(page, /^BOM Prices/)
  await expect(page.getByRole('columnheader', { name: 'Manufacturing €' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Printing €' })).toBeVisible()

  const man = page.getByLabel('H9 manufacturing price')
  await expect(man).toBeEditable()
  const was = await man.inputValue()
  await man.fill(String(Number(was) + 1))
  await expect(page.getByText('1 unsaved change')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save Bamida prices' })).toBeEnabled()
  // Put it back: nothing left to save.
  await man.fill(was)
  await expect(page.getByText(/^Sheet prices from the week of/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save Bamida prices' })).toBeDisabled()
}

function need(c: Creds | null, what: string): Creds {
  test.skip(!c, `Set ${what}`)
  return c!
}

test('Juraj sees which model each product code is costed as, and can change it', async ({ page }) => {
  await login(page, need(jurajCreds(), 'JURAJ_EMAIL/JURAJ_PASSWORD'))
  await checkProductCodes(page)

  // Choosing another model asks first; saying no leaves it as it was.
  const h9x = page.getByLabel('Model EBH9X is costed as')
  const before = await h9x.inputValue()
  let asked = ''
  page.once('dialog', (d) => {
    asked = d.message()
    void d.dismiss()
  })
  await h9x.selectOption('H9')
  expect(asked).toContain('Cost EBH9X as H9?')
  await expect(h9x).toHaveValue(before)
})

test('Juraj can type a Bamida price, and nothing is saved until he says so', async ({ page }) => {
  await login(page, need(jurajCreds(), 'JURAJ_EMAIL/JURAJ_PASSWORD'))
  await checkBamidaPricesTyping(page)
})

test('Juraj sees the re-cost button on an order still waiting to be manufactured', async ({ page }) => {
  await login(page, need(jurajCreds(), 'JURAJ_EMAIL/JURAJ_PASSWORD'))
  await openTab(page, /^SRO Order BOMs/)
  const recost = page.getByRole('button', { name: /Re-cost/ })
  test.skip((await recost.count()) === 0, 'No approved order without a manufacturing order right now')
  let asked = ''
  page.once('dialog', (d) => {
    asked = d.message()
    void d.dismiss()
  })
  await recost.first().click()
  expect(asked).toContain("from today's bill of materials and Bamida prices")
  await expect(page.getByText(/ re-costed$/)).toHaveCount(0)
})

test('Martin (operations) sees both editors the same way', async ({ page }) => {
  await login(page, need(martinCreds(), 'MARTIN_EMAIL/MARTIN_PASSWORD'))
  await checkProductCodes(page)
  await checkBamidaPricesTyping(page)
  // Back to the tab this login had open before the test.
  await page.getByRole('button', { name: /^Materials/ }).click()
})

test('a Bamida price set in the Hub wins, and hands back to the sheet', async ({ page }) => {
  await login(page, need(daveCreds(), 'DAVE_EMAIL/DAVE_PASSWORD'))
  await openTab(page, /^BOM Prices/)
  const print = page.getByLabel('GenExtension printing price')
  // By the model's name: the price box itself goes when "use it" is pressed.
  const row = page.getByRole('row').filter({ hasText: 'GenExtension' })

  const handBack = async () => {
    await page.getByRole('button', { name: "Use the sheet's printing price for GenExtension" }).click()
    await expect(row.getByText(/the sheet.s ·/)).toBeVisible()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: 'Save Bamida prices' }).click()
    await expect(page.getByText('Saved 1 Bamida price').first()).toBeVisible()
    await expect(row.getByText(/^set by/)).toHaveCount(0)
  }
  // A run that stopped half way leaves its test price behind: hand it back first.
  if (await row.getByText(/^set by/).count()) await handBack()

  const sheet = await print.inputValue()
  const typed = (Number(sheet) + 0.01).toFixed(2)

  // Set a Hub price.
  await print.fill(typed)
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Save Bamida prices' }).click()
  await expect(page.getByText('Saved 1 Bamida price').first()).toBeVisible()
  await expect(row.getByText(/^set by/)).toBeVisible()
  await expect(print).toHaveValue(typed)

  // Hand it back to the sheet.
  await handBack()
  await expect(print).toHaveValue(sheet)

  await page.getByRole('button', { name: /^Materials/ }).click()
})

test('a product code costed as another model, and back to the list', async ({ page }) => {
  await login(page, need(daveCreds(), 'DAVE_EMAIL/DAVE_PASSWORD'))
  await openTab(page, /^Product codes/)
  const v1 = page.getByLabel('Model V1 is costed as')
  const row = page.getByRole('row').filter({ has: v1 })
  await expect(v1).toHaveValue('')

  page.once('dialog', (d) => void d.accept())
  await v1.selectOption('V2')
  await expect(page.getByText('V1 is costed as V2')).toBeVisible()
  await expect(v1).toHaveValue('V2')
  await expect(row.getByText('Found', { exact: true })).toBeVisible()

  page.once('dialog', (d) => void d.accept())
  await v1.selectOption('')
  await expect(page.getByText('V1 is costed as V1')).toBeVisible()
  await expect(v1).toHaveValue('')
  await expect(row.getByText(/^Chosen by/)).toHaveCount(0)

  await page.getByRole('button', { name: /^Materials/ }).click()
})
