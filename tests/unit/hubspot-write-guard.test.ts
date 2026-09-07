import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every HubSpot MUTATION must be blocked by the staging kill switch.
 *
 * The central block lives in hubspotFetch, but most of this layer predates it
 * and calls fetch() directly, so the client never sees those requests. Three
 * mutations were found running with no guard at all on 2026-09-07:
 * updateDealAmount, closeDealWon and mark-quote-sent. Each would have written to
 * the real HubSpot portal from a sandbox, and updateDealAmount sits directly on
 * the path a rep takes when they reprice a quote.
 *
 * This walks the files rather than listing them, so a fourth cannot be added
 * quietly. A file passes if it either goes through hubspotFetch or checks
 * externalCallsDisabled itself.
 */
const ROOT = join(process.cwd(), 'src/app/actions')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
}

/**
 * HubSpot uses POST for two of its READ endpoints, `/search` and `/batch/read`,
 * so method alone does not say whether a call mutates anything. Both are
 * excluded here; getLineItems and getProductSkus are exactly that shape and were
 * flagged as unguarded writes on the first run of this test.
 */
const POST_READ_ENDPOINTS = ['/search', '/batch/read']

function mutatesHubSpot(source: string): boolean {
  if (!source.includes('api.hubapi.com')) return false
  if (/method:\s*'(PATCH|DELETE|PUT)'/.test(source)) return true
  if (!/method:\s*'POST'/.test(source)) return false
  return !POST_READ_ENDPOINTS.some((endpoint) => source.includes(endpoint))
}

describe('every HubSpot mutation is behind the staging kill switch', () => {
  const files = walk(ROOT)

  it('finds the action files at all, so a bad path cannot make this vacuously pass', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((f) => f.endsWith('updateDealAmount.ts'))).toBe(true)
  })

  it('leaves no mutation unguarded', () => {
    const unguarded = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
      if (!mutatesHubSpot(source)) return false
      return !source.includes('hubspotFetch') && !source.includes('externalCallsDisabled')
    })
    expect(unguarded.map((f) => f.replace(process.cwd() + '/', ''))).toEqual([])
  })
})
