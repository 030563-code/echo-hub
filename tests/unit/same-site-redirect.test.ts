import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { redirectToPath } from '@/lib/same-site-redirect'

/**
 * 🔴 23 Sep 2026, on the live site: the first organisation switch after signing in redirected to
 * `6ab3a0b771289d0008d30a7d--hub-echo.netlify.app/login`. On Netlify a route handler's request.url
 * can carry the deploy's own host, and /org/[code] built its redirect with new URL(path,
 * request.url), so the browser left hub.echobarrier.com for a host where the session cookie does
 * not exist and landed on a login page, looking exactly like being signed out.
 */
describe('redirectToPath sends a relative Location that cannot change host', () => {
  it('keeps the path and query, and defaults to 307', () => {
    const res = redirectToPath('/invoicing/accepted')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/invoicing/accepted')
    expect(redirectToPath('/login?error=missing_code').headers.get('location')).toBe('/login?error=missing_code')
  })

  it('carries a 303 for a POST that must be followed with a GET', () => {
    expect(redirectToPath('/login', 303).status).toBe(303)
  })

  it('collapses anything that is not a path on this site to the dashboard', () => {
    for (const target of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'login', '', '/a b']) {
      expect(redirectToPath(target).headers.get('location'), target).toBe('/')
    }
  })

  it('still lets a caller set a cookie on the response', () => {
    const res = redirectToPath('/invoicing')
    res.cookies.set('hub_org', 'EB-FRANCE', { path: '/' })
    expect(res.headers.getSetCookie().join('\n')).toContain('hub_org=EB-FRANCE')
  })
})

/** Every route handler under src/app, so a new one is covered the day it is written. */
function routeHandlers(dir = join(process.cwd(), 'src/app')): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeHandlers(full))
    else if (name === 'route.ts') out.push(full)
  }
  return out
}

const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('guard: no route handler builds a redirect from the request address', () => {
  const files = routeHandlers()

  it('finds the handlers it is meant to guard', () => {
    const names = files.map((f) => relative(process.cwd(), f))
    for (const expected of [
      'src/app/org/[code]/route.ts',
      'src/app/sign-out/route.ts',
      'src/app/auth/callback/route.ts',
      'src/app/factory-lang/[locale]/route.ts',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('uses redirectToPath, never NextResponse.redirect, new URL(..., request.url) or the request origin', () => {
    for (const file of files) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      const name = relative(process.cwd(), file)
      expect(src, name).not.toContain('NextResponse.redirect(')
      expect(src, name).not.toMatch(/new URL\([^)]*,\s*(request|req)\.url\)/)
      expect(src, name).not.toMatch(/\$\{origin\}/)
    }
  })
})
