import { test, expect, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { deflateSync } from 'node:zlib'
import { adminCreds, limitedCreds, login } from './helpers'

/**
 * Your profile, end to end: job title, bio and photo.
 *
 * Runs as the admin persona against its OWN profile, so it captures the job
 * title, bio and photo that were there first and puts them back at the end,
 * pass or fail. The photo restore re-uploads the original bytes, which the page
 * re-encodes, so a restored photo is the same picture but not the same file.
 *
 * It refuses to start if a photo is on screen but its bytes could not be read,
 * because the upload below would overwrite the only copy. The originals are also
 * written to the test's output folder, so a restore that fails can be done by
 * hand before the next run clears that folder.
 *
 * Every step inside the try has its own timeout, well inside the test's, so a
 * hung click still leaves the finally block time to put things back.
 */

const admin = adminCreds()
const limited = limitedCreds()

/** Per action inside the test. Short enough that several can fail and restore still runs. */
const STEP_MS = 15_000
/** Per navigation, which may compile the route on a cold dev server. */
const NAV_MS = 30_000

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

/** Open the page and wait until the details form shows what is really saved.
 *  A leftover draft from an earlier run is discarded first.
 *
 *  "No changes to save." is the signal: the form shows it only when the job
 *  title and bio, trimmed, equal the saved values and no save is running. While
 *  a draft that differs is on screen it is hidden, so it cannot pass early. */
async function openProfile(page: Page) {
  await page.goto('/profile', { timeout: NAV_MS })
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible({ timeout: NAV_MS })
  await expect(page.getByLabel('Job title')).toBeVisible({ timeout: NAV_MS })
  const discard = page.getByRole('button', { name: 'Discard these changes' })
  if (await discard.isVisible()) await discard.click({ timeout: STEP_MS })
  await expect(page.getByText('No changes to save.')).toBeVisible({ timeout: STEP_MS })
}

async function saveDetails(page: Page, jobTitle: string, bio: string) {
  await page.getByLabel('Job title').fill(jobTitle, { timeout: STEP_MS })
  await page.getByLabel('Bio').fill(bio, { timeout: STEP_MS })
  const save = page.getByRole('button', { name: 'Save details' })
  if (await save.isDisabled()) return // already saved exactly this
  await save.click({ timeout: STEP_MS })
  await expect(page.getByText('Your details are saved.')).toBeVisible({ timeout: STEP_MS })
}

const avatarBox = (page: Page) => page.getByTestId('profile-avatar')

test.describe('Your profile', () => {
  test.skip(!admin, 'Set E2E_USERNAME/E2E_PASSWORD to run the profile path')

  test('job title, bio and photo save, show, and stay private', async ({
    page,
    browser,
    playwright,
    baseURL,
  }, testInfo) => {
    test.setTimeout(240_000)
    // Remove photo asks first. Playwright dismisses dialogs by default, which
    // would silently cancel the removal, so accept that one confirm and no other.
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'confirm' && dialog.message().startsWith('Remove your photo?')) void dialog.accept()
      else void dialog.dismiss()
    })
    // A photo that fails to load is shown as initials, so "no img" alone does not
    // mean "no photo". Any failed photo request on this page counts as a photo
    // that exists but could not be read.
    const photoFailures: string[] = []
    const isPhotoUrl = (url: string) => new URL(url).pathname.startsWith('/api/avatar/')
    page.on('response', (res) => {
      if (isPhotoUrl(res.url()) && res.status() !== 200) photoFailures.push(`${res.status()} ${res.url()}`)
    })
    page.on('requestfailed', (req) => {
      if (isPhotoUrl(req.url())) photoFailures.push(`failed ${req.url()}`)
    })
    await login(page, admin!)
    await openProfile(page)

    // What was there before, so it can be put back.
    const originalJobTitle = await page.getByLabel('Job title').inputValue()
    const originalBio = await page.getByLabel('Bio').inputValue()
    const originalImg = avatarBox(page).locator('img')
    let originalPhoto: { buffer: Buffer; mimeType: string } | null = null
    if ((await originalImg.count()) > 0) {
      const src = await originalImg.getAttribute('src')
      const res = src ? await page.request.get(src, { timeout: STEP_MS }) : null
      const mimeType = res?.headers()['content-type'] ?? ''
      if (!res || res.status() !== 200 || !/^image\/(jpeg|png|webp)$/.test(mimeType)) {
        // Nothing has been changed yet. Going on would overwrite the only copy.
        throw new Error(
          `The profile shows a photo but its bytes could not be read (${res ? `${res.status()} ${mimeType}` : 'no src'}). ` +
            'Stopping before anything is changed.',
        )
      }
      originalPhoto = { buffer: await res.body(), mimeType }
    } else if (photoFailures.length > 0) {
      throw new Error(
        `The profile shows initials but a photo request failed (${photoFailures.join(', ')}). ` +
          'Stopping before anything is changed.',
      )
    }

    // A copy on disk, for putting things back by hand if the restore fails.
    const keep = async (name: string, data: string | Buffer) => {
      const file = testInfo.outputPath(name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, data)
    }
    await keep('original-profile.json', JSON.stringify({ jobTitle: originalJobTitle, bio: originalBio }, null, 2))
    if (originalPhoto) {
      await keep(`original-avatar.${originalPhoto.mimeType.split('/')[1]}`, originalPhoto.buffer)
    }

    const stamp = Date.now()
    const jobTitle = `E2E Operations Manager ${stamp}`
    const bio = `E2E bio ${stamp}. Looks after the profile page test.`

    try {
      // ---- Details ----
      await saveDetails(page, jobTitle, bio)
      await page.reload({ timeout: NAV_MS })
      await openProfile(page)
      await expect(page.getByLabel('Job title')).toHaveValue(jobTitle)
      await expect(page.getByLabel('Bio')).toHaveValue(bio)
      await expect(page.getByText(`${bio.length} / 500`)).toBeVisible()

      // ---- Photo upload ----
      await page.locator('input[type="file"]').setInputFiles(
        {
          name: 'e2e-avatar.png',
          mimeType: 'image/png',
          buffer: makePng(64, [255, 112, 38]),
        },
        { timeout: STEP_MS },
      )
      await expect(page.getByAltText('Preview of your new photo')).toBeVisible({ timeout: STEP_MS })
      await page.getByRole('button', { name: 'Save photo' }).click({ timeout: STEP_MS })
      await expect(page.getByText('Your photo is saved.')).toBeVisible({ timeout: STEP_MS })

      const img = avatarBox(page).locator('img')
      await expect(img).toHaveAttribute('src', /^\/api\/avatar\//, { timeout: STEP_MS })
      const src = (await img.getAttribute('src'))!
      const served = await page.request.get(src, { timeout: STEP_MS })
      expect(served.status()).toBe(200)
      expect(served.headers()['content-type']).toMatch(/^image\/(jpeg|png|webp)$/)

      const adminId = src.match(/^\/api\/avatar\/([0-9a-f-]{36})/)?.[1]
      expect(adminId, 'the avatar url carries the user id').toBeTruthy()

      // ---- Nobody without a session gets it ----
      const anon = await playwright.request.newContext({ baseURL })
      try {
        const res = await anon.get(`/api/avatar/${adminId}`, { maxRedirects: 0, timeout: STEP_MS })
        expect(res.status()).not.toBe(200)
        if (res.status() >= 300 && res.status() < 400) {
          expect(res.headers()['location'] ?? '').toContain('/login')
        }
      } finally {
        await anon.dispose()
      }

      // ---- A signed-in user who is neither the owner nor a super admin gets 404 ----
      await test.step('another signed-in user cannot fetch the photo', async (step) => {
        step.skip(!limited, 'Set E2E_LIMITED_USERNAME/E2E_LIMITED_PASSWORD to check another user gets 404')
        const context = await browser.newContext({ baseURL })
        try {
          const other = await context.newPage()
          await login(other, limited!)
          const res = await other.request.get(`/api/avatar/${adminId}`, { maxRedirects: 0, timeout: STEP_MS })
          expect(res.status()).toBe(404)
        } finally {
          await context.close()
        }
      })

      // ---- Photo removal ----
      await page.getByRole('button', { name: 'Remove photo' }).click({ timeout: STEP_MS })
      await expect(page.getByText('Your photo is removed.')).toBeVisible({ timeout: STEP_MS })
      await expect(avatarBox(page).locator('img')).toHaveCount(0, { timeout: STEP_MS })
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
