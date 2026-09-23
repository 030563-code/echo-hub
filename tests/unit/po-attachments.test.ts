import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  PO_ATTACHMENT_MAX_BYTES,
  PO_ATTACHMENT_TYPES,
  checkPoAttachment,
  isPathInsidePo,
  poAttachmentPath,
} from '@/lib/po-attachments'
import { AVATAR_MAX_BYTES } from '@/lib/profile/avatar'

/**
 * Purchase order attachments go browser to Storage with a signed token.
 *
 * 23 Sep 2026: uploading "H10 2026 Celtic.pdf" to a purchase order replaced the
 * page with "Something went wrong", reference 2427372018@E394. The file went
 * through a server action, whose body Next caps at 1 MB ("Body exceeded 1 MB
 * limit"), while the action and the bucket both promised 10 MB. The old e2e test
 * uploaded 28 bytes, which is why it never showed.
 */

const PO = 'f76b8e22-e13b-46d5-8339-3369629a1f2a'
const OTHER = '00000000-0000-0000-0000-000000000000'
const UNIQUE = '11111111-2222-3333-4444-555555555555'
const MB = 1024 * 1024

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260624000400_hub_po_attachments.sql'),
  'utf8',
)

describe('the limits match the bucket', () => {
  it('allows the size the bucket allows', () => {
    const limit = migration.match(/'po-attachments', 'po-attachments', false,\s*(\d+)/)
    expect(limit, 'the bucket insert in the migration').not.toBeNull()
    expect(PO_ATTACHMENT_MAX_BYTES).toBe(Number(limit![1]))
    expect(PO_ATTACHMENT_MAX_BYTES).toBe(10 * MB)
  })

  it('allows exactly the types the bucket allows', () => {
    const list = migration.match(/ARRAY\[([^\]]+)\]/)
    expect(list, 'the allowed_mime_types array in the migration').not.toBeNull()
    const bucketTypes = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect([...PO_ATTACHMENT_TYPES].sort()).toEqual(bucketTypes.sort())
  })
})

describe('checkPoAttachment', () => {
  it('accepts the PDF that broke the page, and one at exactly 10 MB', () => {
    expect(checkPoAttachment('application/pdf', 3 * MB)).toEqual({ ok: true })
    expect(checkPoAttachment('application/pdf', 10 * MB)).toEqual({ ok: true })
  })

  it('refuses a file over 10 MB, and an empty one', () => {
    expect(checkPoAttachment('application/pdf', 10 * MB + 1).ok).toBe(false)
    expect(checkPoAttachment('application/pdf', 0).ok).toBe(false)
    expect(checkPoAttachment('application/pdf', Number.NaN).ok).toBe(false)
  })

  it('refuses a type the bucket would refuse, including a blank one', () => {
    expect(checkPoAttachment('application/octet-stream', 1000).ok).toBe(false)
    expect(checkPoAttachment('application/zip', 1000).ok).toBe(false)
  })
})

describe('poAttachmentPath and isPathInsidePo', () => {
  it("names the object inside the order's folder and keeps the extension", () => {
    const path = poAttachmentPath(PO, UNIQUE, 'H10 2026 Celtic.pdf')
    expect(path).toBe(`${PO}/${UNIQUE}-H10-2026-Celtic.pdf`)
    expect(isPathInsidePo(path, PO)).toBe(true)
  })

  it('keeps a hostile filename inside the folder', () => {
    const path = poAttachmentPath(PO, UNIQUE, '../../other/secret.pdf')
    expect(path).toBe(`${PO}/${UNIQUE}-secret.pdf`)
    expect(isPathInsidePo(path, PO)).toBe(true)
  })

  it("refuses a path in another order's folder, or outside the scheme", () => {
    expect(isPathInsidePo(`${OTHER}/${UNIQUE}-x.pdf`, PO)).toBe(false)
    expect(isPathInsidePo(`${PO}/../${OTHER}/x.pdf`, PO)).toBe(false)
    expect(isPathInsidePo(`${PO}/nested/x.pdf`, PO)).toBe(false)
    expect(isPathInsidePo(`${PO}/`, PO)).toBe(false)
    expect(isPathInsidePo(`x${PO}/${UNIQUE}-x.pdf`, PO)).toBe(false)
  })
})

describe('no server action carries a file over 1 MB', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []
    })

  it('reads file bytes in one action only, the photo, which is capped well under the limit', () => {
    const actionsDir = join(process.cwd(), 'src/app/actions')
    const readers = walk(actionsDir)
      .filter((path) => /instanceof File\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path))
    // A new entry here is a new upload through a server action, which Next caps
    // at 1 MB. Mint a signed upload instead (src/lib/po-attachments.ts).
    expect(readers).toEqual(['src/app/actions/profile.ts'])
    expect(AVATAR_MAX_BYTES).toBeLessThan(MB)
  })
})
