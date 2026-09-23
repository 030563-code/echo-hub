import { test, expect } from '@playwright/test'
import { adminCreds, login } from './helpers'

/**
 * 23 Sep 2026: uploading "H10 2026 Celtic.pdf" to a purchase order replaced the
 * page with "Something went wrong", reference 2427372018@E394. The file went
 * through a server action, which Next caps at 1 MB. It now goes browser to
 * Storage with a signed token, so a real-sized PDF attaches.
 *
 * Writes to a live order and cleans up: EBUSA8001 is a depot order, which the
 * factory can never be given a file on, and the file is deleted at once. The old
 * attachments test uploads 28 bytes, which is why the limit never showed.
 */

// EBUSA8001, Echo Barrier USA's first order through the Hub.
const PO_ID = 'f76b8e22-e13b-46d5-8339-3369629a1f2a'
const MB = 1024 * 1024

/** A PDF-typed buffer of the given size. Storage checks the declared type and
 *  the size, not the content. */
const pdf = (bytes: number) => {
  const head = Buffer.from('%PDF-1.4\n% e2e upload check, deleted by the test\n')
  return Buffer.concat([head, Buffer.alloc(bytes - head.length, 0x20)])
}

test.describe('purchase order attachments above 1 MB', () => {
  const admin = adminCreds()
  test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD')

  test.beforeEach(async ({ page }) => {
    await login(page, admin!)
  })

  test('a 3 MB PDF attaches, is listed, and deletes', async ({ page }) => {
    const name = 'e2e-3mb-upload-check.pdf'
    await page.goto(`/purchase-orders/${PO_ID}`)
    await expect(page.getByText('Attachments', { exact: true })).toBeVisible()
    await expect(page.getByText(name)).toHaveCount(0)

    await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({
      name,
      mimeType: 'application/pdf',
      buffer: pdf(3 * MB),
    })

    await expect(page.getByText(`${name} attached`)).toBeVisible({ timeout: 60_000 })
    const row = page.locator('div.bg-gray-50').filter({ hasText: name })
    await expect(row).toBeVisible()
    await expect(page.getByText('Something went wrong')).toHaveCount(0)

    page.once('dialog', (dialog) => dialog.accept())
    await row.getByTitle('Delete').click()
    await expect(page.getByText('Attachment deleted')).toBeVisible()
    await expect(page.getByText(name)).toHaveCount(0)
  })

  test('a file over 10 MB is refused in words, and the page stays', async ({ page }) => {
    const name = 'e2e-too-large.pdf'
    await page.goto(`/purchase-orders/${PO_ID}`)
    await expect(page.getByText('Attachments', { exact: true })).toBeVisible()

    await page.locator('input[type=file][accept*=".pdf"]').setInputFiles({
      name,
      mimeType: 'application/pdf',
      buffer: pdf(10 * MB + 1),
    })

    await expect(page.getByText(`${name} is larger than 10 MB.`).first()).toBeVisible()
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await expect(page.getByText('Attachments', { exact: true })).toBeVisible()
  })
})
