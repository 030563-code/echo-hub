import { describe, it, expect, afterEach } from 'vitest'
import { hubspotRecordUrl } from '@/lib/hubspot-links'

const ORIGINAL = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
  else process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = ORIGINAL
})

describe('hubspotRecordUrl', () => {
  it('builds the durable object-type URL for each record kind', () => {
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = '3882358'
    expect(hubspotRecordUrl('deal', '123')).toBe('https://app.hubspot.com/contacts/3882358/record/0-3/123')
    expect(hubspotRecordUrl('company', '456')).toBe('https://app.hubspot.com/contacts/3882358/record/0-2/456')
    expect(hubspotRecordUrl('contact', '789')).toBe('https://app.hubspot.com/contacts/3882358/record/0-1/789')
  })

  it('returns null with no portal id, rather than a URL that 404s', () => {
    delete process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
    expect(hubspotRecordUrl('deal', '123')).toBeNull()
  })

  it('returns null for a missing or blank record id', () => {
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = '3882358'
    expect(hubspotRecordUrl('company', null)).toBeNull()
    expect(hubspotRecordUrl('company', undefined)).toBeNull()
    expect(hubspotRecordUrl('company', '  ')).toBeNull()
  })
})

describe('quote record URLs', () => {
  it('uses the durable 0-14 object-type form for a HubSpot quote', () => {
    // Phase B links the rep from the Hub to the quote it just published. The
    // object-type path is the shape HubSpot has not broken; /quote/{id} is not
    // a route that exists.
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = '3882358'
    const url = hubspotRecordUrl('quote', '42607942261')
    expect(url).toBe('https://app.hubspot.com/contacts/3882358/record/0-14/42607942261')
  })
})

/**
 * The helper was right and still the button was broken, because one call site
 * never used it: the deal page hand-built the legacy /deal/{id} path, which
 * HubSpot no longer redirects, so "Edit in HubSpot" opened nothing. Testing the
 * helper harder would not have caught that. This does.
 */
describe('no call site hand-builds a HubSpot URL', () => {
  it('leaves app.hubspot.com to hubspot-links.ts alone', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        if (full.endsWith(join('lib', 'hubspot-links.ts'))) continue
        const source = await readFile(full, 'utf8')
        // The literal is what matters; a comment mentioning it is fine.
        if (/href[^\n]*app\.hubspot\.com/.test(source)) offenders.push(full)
      }
    }
    await walk('src')

    expect(offenders, `build these with hubspotRecordUrl instead: ${offenders.join(', ')}`).toEqual([])
  })
})
