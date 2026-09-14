import { describe, it, expect } from 'vitest'
import {
  AVATAR_BUCKET,
  AVATAR_EDGE,
  AVATAR_MAX_BYTES,
  BIO_MAX,
  JOB_TITLE_MAX,
  avatarSrc,
  avatarVersion,
  initialsFor,
  sniffImageType,
} from '@/lib/profile/avatar'
import { parseProfileDetailsDraft } from '@/lib/page-drafts'

const bytes = (...values: number[]) => new Uint8Array(values)
const ascii = (text: string) => new TextEncoder().encode(text)

/** A real 12-byte WebP header: RIFF, a chunk size, WEBP. */
const WEBP = new Uint8Array([...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WEBP'), ...ascii('VP8 ')])

describe('the shared limits', () => {
  it('match the bucket and the database', () => {
    expect(AVATAR_MAX_BYTES).toBe(524288)
    expect(AVATAR_BUCKET).toBe('avatars')
    expect(AVATAR_EDGE).toBe(512)
    expect(BIO_MAX).toBe(500)
    expect(JOB_TITLE_MAX).toBe(80)
  })
})

describe('sniffImageType', () => {
  it('recognises a JPEG by FF D8 FF', () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46))).toBe('image/jpeg')
  })

  it('recognises a PNG by its full eight-byte signature', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d))).toBe(
      'image/png',
    )
  })

  it('recognises a WebP by RIFF at 0 and WEBP at 8', () => {
    expect(sniffImageType(WEBP)).toBe('image/webp')
  })

  it('refuses an SVG, which can carry script', () => {
    expect(sniffImageType(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(sniffImageType(ascii('<?xml version="1.0"?><svg></svg>'))).toBeNull()
  })

  it('refuses a GIF', () => {
    expect(sniffImageType(ascii('GIF89a\x01\x00\x01\x00'))).toBeNull()
  })

  it('refuses HTML', () => {
    expect(sniffImageType(ascii('<!doctype html><html><body>hi</body></html>'))).toBeNull()
  })

  it('refuses an empty buffer', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull()
  })

  it('refuses a truncated PNG header', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull()
  })

  it('refuses a RIFF file that is not WebP, and a RIFF too short to say', () => {
    expect(sniffImageType(new Uint8Array([...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WAVE')]))).toBeNull()
    expect(sniffImageType(ascii('RIFF'))).toBeNull()
    expect(sniffImageType(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEB')]))).toBeNull()
  })

  it('refuses a JPEG signature that is not at the start', () => {
    expect(sniffImageType(bytes(0x00, 0xff, 0xd8, 0xff))).toBeNull()
  })
})

describe('avatarSrc', () => {
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

  it('is null when there is no photo', () => {
    expect(avatarSrc(id, null)).toBeNull()
  })

  it('is null for a timestamp that does not parse', () => {
    expect(avatarSrc(id, 'not a date')).toBeNull()
  })

  it('is a same-origin url versioned by the time the photo changed', () => {
    const at = '2026-09-14T10:00:00.000Z'
    expect(avatarSrc(id, at)).toBe(`/api/avatar/${id}?v=${Date.parse(at)}`)
  })

  it('changes when the photo changes', () => {
    expect(avatarSrc(id, '2026-09-14T10:00:00Z')).not.toBe(avatarSrc(id, '2026-09-14T10:00:01Z'))
  })

  it('carries exactly the version the image route compares against', () => {
    // Postgres returns microseconds; both sides must truncate them the same way.
    const at = '2026-09-14T10:00:00.123456+00:00'
    const v = new URL(avatarSrc(id, at)!, 'http://x').searchParams.get('v')
    expect(v).toBe(String(avatarVersion(at)))
    expect(avatarVersion(at)).toBe(Date.parse('2026-09-14T10:00:00.123Z'))
  })
})

describe('avatarVersion', () => {
  it('is null with no photo or an unparseable timestamp', () => {
    expect(avatarVersion(null)).toBeNull()
    expect(avatarVersion('')).toBeNull()
    expect(avatarVersion('not a date')).toBeNull()
  })
})

describe('initialsFor', () => {
  it('takes the first and last names', () => {
    expect(initialsFor('Dean Jeggels')).toBe('DJ')
    expect(initialsFor('  mary anne van der berg ')).toBe('MB')
  })

  it('takes one letter for one name', () => {
    expect(initialsFor('juraj')).toBe('J')
  })

  it('falls back to the email local part', () => {
    expect(initialsFor(null, 'dean.jeggels@example.com')).toBe('DJ')
    expect(initialsFor('', 'juraj@example.com')).toBe('J')
    expect(initialsFor('   ', 'ops_team@example.com')).toBe('OT')
  })

  it('prefers the name over the email', () => {
    expect(initialsFor('Juraj', 'dean.jeggels@example.com')).toBe('J')
  })

  it('handles accented letters', () => {
    expect(initialsFor('Ondřej Šimek')).toBe('OŠ')
  })

  it('is "?" with nothing to go on', () => {
    expect(initialsFor(null)).toBe('?')
    expect(initialsFor(undefined, null)).toBe('?')
    expect(initialsFor('', '')).toBe('?')
    expect(initialsFor('---', '@example.com')).toBe('?')
  })
})

describe('the profile details draft', () => {
  it('parses what the page writes', () => {
    expect(parseProfileDetailsDraft({ v: 1, jobTitle: 'Operations Manager', bio: 'Hello' })).toEqual({
      v: 1,
      jobTitle: 'Operations Manager',
      bio: 'Hello',
    })
  })

  it('treats anything else as no draft', () => {
    expect(parseProfileDetailsDraft({ v: 1, bio: 'Hello' })).toBeNull()
    expect(parseProfileDetailsDraft({ v: 2, jobTitle: '', bio: '' })).toBeNull()
    expect(parseProfileDetailsDraft({ v: 1, jobTitle: 'x'.repeat(JOB_TITLE_MAX + 1), bio: '' })).toBeNull()
    expect(parseProfileDetailsDraft({ v: 1, jobTitle: '', bio: 'x'.repeat(BIO_MAX + 1) })).toBeNull()
    expect(parseProfileDetailsDraft(null)).toBeNull()
  })
})
