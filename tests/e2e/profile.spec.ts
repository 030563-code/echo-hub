import { test, expect, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { adminCreds, login } from './helpers'

/**
 * Your profile, end to end: job title, bio and photo.
 *
 * Runs as the admin persona against its OWN profile, so it captures the job
 * title, bio and photo that were there first and puts them back at the end,
 * pass or fail. The photo restore re-uploads the original bytes, which the page
 * re-encodes, so a restored photo is the same picture but not the same file.
 */

const admin = adminCreds()

/** A real, decodable PNG: a solid square, built by hand so no fixture file is needed. */
function makePng(size: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Open the page and wait until the details form has finished reading its draft.
 *  A leftover draft from an earlier run is discarded, so the inputs show what is
 *  really saved. */
async function openProfile(page: Page) {
  await page.goto('/profile')
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Job title')).toBeVisible({ timeout: 30_000 })
  const discard = page.getByRole('button', { name: 'Discard these changes' })
  if (await discard.isVisible()) await discard.click()
}

async function saveDetails(page: Page, jobTitle: string, bio: string) {
  await page.getByLabel('Job title').fill(jobTitle)
  await page.getByLabel('Bio').fill(bio)
  const save = page.getByRole('button', { name: 'Save details' })
  if (await save.isDisabled()) return // already saved exactly this
  await save.click()
  await expect(page.getByText('Your details are saved.')).toBeVisible({ timeout: 15_000 })
}

const avatarBox = (page: Page) => page.getByTestId('profile-avatar')

test.describe('Your profile', () => {
  test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD to run the profile path')

  test('job title, bio and photo save, show, and stay private', async ({ page, playwright, baseURL }) => {
    test.setTimeout(180_000)
    await login(page, admin!)
    await openProfile(page)

    // What was there before, so it can be put back.
    const originalJobTitle = await page.getByLabel('Job title').inputValue()
    const originalBio = await page.getByLabel('Bio').inputValue()
    const originalImg = avatarBox(page).locator('img')
    let originalPhoto: { buffer: Buffer; mimeType: string } | null = null
    if ((await originalImg.count()) > 0) {
      const src = await originalImg.getAttribute('src')
      const res = src ? await page.request.get(src) : null
      if (res?.ok()) {
        originalPhoto = { buffer: await res.body(), mimeType: res.headers()['content-type'] ?? 'image/jpeg' }
      }
    }

    const stamp = Date.now()
    const jobTitle = `E2E Operations Manager ${stamp}`
    const bio = `E2E bio ${stamp}. Looks after the profile page test.`

    try {
      // ---- Details ----
      await saveDetails(page, jobTitle, bio)
      await page.reload()
      await openProfile(page)
      await expect(page.getByLabel('Job title')).toHaveValue(jobTitle)
      await expect(page.getByLabel('Bio')).toHaveValue(bio)
      await expect(page.getByText(`${bio.length} / 500`)).toBeVisible()

      // ---- Photo upload ----
      await page.locator('input[type="file"]').setInputFiles({
        name: 'e2e-avatar.png',
        mimeType: 'image/png',
        buffer: makePng(64, [255, 112, 38]),
      })
      await expect(page.getByAltText('Preview of your new photo')).toBeVisible({ timeout: 15_000 })
      await page.getByRole('button', { name: 'Save photo' }).click()
      await expect(page.getByText('Your photo is saved.')).toBeVisible({ timeout: 15_000 })

      const img = avatarBox(page).locator('img')
      await expect(img).toHaveAttribute('src', /^\/api\/avatar\//, { timeout: 15_000 })
      const src = (await img.getAttribute('src'))!
      const served = await page.request.get(src)
      expect(served.status()).toBe(200)
      expect(served.headers()['content-type']).toMatch(/^image\/(jpeg|png|webp)$/)

      const adminId = src.match(/^\/api\/avatar\/([0-9a-f-]{36})/)?.[1]
      expect(adminId, 'the avatar url carries the user id').toBeTruthy()

      // ---- Nobody without a session gets it ----
      const anon = await playwright.request.newContext({ baseURL })
      try {
        const res = await anon.get(`/api/avatar/${adminId}`, { maxRedirects: 0 })
        expect(res.status()).not.toBe(200)
        if (res.status() >= 300 && res.status() < 400) {
          expect(res.headers()['location'] ?? '').toContain('/login')
        }
      } finally {
        await anon.dispose()
      }

      // ---- Photo removal ----
      await page.getByRole('button', { name: 'Remove photo' }).click()
      await expect(page.getByText('Your photo is removed.')).toBeVisible({ timeout: 15_000 })
      await expect(avatarBox(page).locator('img')).toHaveCount(0, { timeout: 15_000 })
      await expect(avatarBox(page).getByRole('img')).toHaveText(/^[A-Z0-9?]{1,2}$/)
    } finally {
      // ---- Put everything back ----
      await openProfile(page)
      await saveDetails(page, originalJobTitle, originalBio)

      const hasPhotoNow = (await avatarBox(page).locator('img').count()) > 0
      if (originalPhoto) {
        await page.locator('input[type="file"]').setInputFiles({
          name: 'restored-avatar',
          mimeType: originalPhoto.mimeType,
          buffer: originalPhoto.buffer,
        })
        await page.getByRole('button', { name: 'Save photo' }).click()
        await expect(page.getByText('Your photo is saved.').last()).toBeVisible({ timeout: 15_000 })
      } else if (hasPhotoNow) {
        await page.getByRole('button', { name: 'Remove photo' }).click()
        await expect(page.getByText('Your photo is removed.').last()).toBeVisible({ timeout: 15_000 })
      }
    }
  })
})
