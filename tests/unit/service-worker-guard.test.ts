import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The installed Hub must never show a figure it did not just fetch.
 *
 * A service worker is what makes the app installable, and it is also the one
 * thing in the codebase that can silently serve yesterday's data inside a
 * window that looks live. The rule is that it caches build assets and nothing
 * else. This reads public/sw.js and fails the build if that stops being true,
 * the same genre of guard as stock-write-guard and email-recipients-guard: a
 * rule that only holds while somebody is looking is not a rule.
 */

const SW = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')

/** The body of the `if (...) { ... }` block that follows `needle`. */
function blockAfter(source: string, needle: string): string {
  const start = source.indexOf(needle)
  expect(start, `guard not found: ${needle}`).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced block after ${needle}`)
}

describe('service worker', () => {
  it('self-check: the worker is there and hooks fetch', () => {
    // A matcher that quietly stops matching would make this file always pass.
    expect(SW.length).toBeGreaterThan(500)
    expect(SW).toContain("addEventListener('fetch'")
  })

  it('never touches a write: Server Actions are POSTs', () => {
    expect(SW).toMatch(/if \(request\.method !== 'GET'\) return;/)
  })

  it('caches in exactly one place, and only under /_next/static/', () => {
    const puts = SW.match(/cache\.put\(/g) ?? []
    expect(puts).toHaveLength(1)
    const assets = blockAfter(SW, "url.pathname.startsWith('/_next/static/')")
    expect(assets).toContain('cache.put(')
    // Nothing may be cached before that branch is reached.
    expect(SW.indexOf('cache.put(')).toBeGreaterThan(SW.indexOf('/_next/static/'))
  })

  it('serves page loads from the network, with the offline card as the fallback', () => {
    const nav = blockAfter(SW, "request.mode === 'navigate'")
    expect(nav).toContain('fetch(request)')
    expect(nav).toContain('OFFLINE_URL')
    // A cached page would be a live-looking screen full of stale figures.
    expect(nav).not.toContain('caches.match(request)')
  })

  it('precaches only the offline card and an icon, never a route or an api', () => {
    const list = SW.match(/cache\.addAll\(\[([^\]]*)\]\)/)
    expect(list, 'precache list not found').toBeTruthy()
    const entries = [...(list?.[1] ?? '').matchAll(/'([^']+)'|([A-Z_]+)/g)].map((m) => m[1] ?? m[2])
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(['OFFLINE_URL', '/icon-192.png'], `precached: ${entry}`).toContain(entry)
    }
    expect(SW).not.toContain('/api/')
  })

  it('drops every cache from an older version on activate', () => {
    expect(SW).toContain("addEventListener('activate'")
    expect(SW).toContain('caches.delete(')
  })
})

describe('installable app', () => {
  const manifest = readFileSync(join(process.cwd(), 'src/app/manifest.ts'), 'utf8')

  it('ships every icon the manifest names, plus the offline card', () => {
    const srcs = [...manifest.matchAll(/src: '([^']+)'/g)].map((m) => m[1])
    expect(srcs.length).toBeGreaterThanOrEqual(3)
    for (const src of [...srcs, '/offline.html', '/sw.js']) {
      expect(existsSync(join(process.cwd(), 'public', src)), `missing public${src}`).toBe(true)
    }
  })

  it('installs as its own window, on the brand colour', () => {
    expect(manifest).toContain("display: 'standalone'")
    expect(manifest).toContain("theme_color: '#FF7026'")
    expect(manifest).toContain("purpose: 'maskable'")
  })

  it('registers the worker from the root layout, so login is covered too', () => {
    const layout = readFileSync(join(process.cwd(), 'src/app/layout.tsx'), 'utf8')
    expect(layout).toContain('RegisterServiceWorker')
    expect(layout).toContain('/manifest.webmanifest')
  })

  it('leaves the offline card reachable without a session, and nothing else new', () => {
    // The worker precaches it on the login page, where nobody has a session
    // yet. Gated, the login page would be cached under that name instead.
    const mw = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8')
    const list = mw.match(/const PUBLIC_PATHS = \[([^\]]*)\]/)
    const paths = [...(list?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    // /manufacturing left on 16 Sep 2026: the factory has a Hub login now, so
    // the signed-link page it exempted no longer exists.
    expect(paths).toEqual(['/login', '/onboarding', '/auth/callback', '/offline.html'])
    // The worker itself and the manifest ride the matcher's extension list.
    expect(mw).toContain('webmanifest')
  })

  it('keeps Netlify from caching the worker or the manifest', () => {
    const netlify = readFileSync(join(process.cwd(), 'netlify.toml'), 'utf8')
    for (const path of ['/sw.js', '/manifest.webmanifest']) {
      expect(netlify).toContain(`for = "${path}"`)
    }
    expect(netlify).toContain('max-age=0, must-revalidate')
  })
})
