import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sign out survives a deploy, and nothing in the Hub is a dead end.
 *
 * Dean, 16 Sep 2026: "when I press sign out it goes to the This page couldnt
 * load page on the prod version." Reproduced against production by sending the
 * Server Action id a pre-deploy tab would send: the server answered 404 with
 * "Server Action ... was not found on the server", and with no error boundary
 * anywhere the page fell to Next's built-in dead end.
 *
 * Two rules, both easy to undo by accident, hence this file.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const ROUTE = 'src/app/sign-out/route.ts'
const SIDEBAR = 'src/components/nav/sidebar.tsx'
const RECOVERY = 'src/components/errors/error-recovery.tsx'

describe('sign out does not depend on which build rendered the page', () => {
  it('is a route handler, not a Server Action', () => {
    expect(existsSync(join(process.cwd(), ROUTE)), 'src/app/sign-out/route.ts').toBe(true)
    // The Server Action it replaced is gone, and nothing imports it.
    expect(existsSync(join(process.cwd(), 'src/app/actions/sign-out.ts'))).toBe(false)
    expect(code(SIDEBAR)).not.toContain('@/app/actions/sign-out')
  })

  it('the sidebar submits a plain form to it, so it works unhydrated', () => {
    expect(code(SIDEBAR)).toContain('<form method="post" action="/sign-out">')
  })

  it('accepts POST only: a GET would let a prefetch or a crawler sign people out', () => {
    const src = code(ROUTE)
    expect(src).toMatch(/export async function POST\(/)
    expect(src).not.toMatch(/export async function GET\(/)
  })

  it('refuses a submit from another site', () => {
    const src = code(ROUTE)
    expect(src).toContain("request.headers.get('sec-fetch-site')")
    expect(src).toContain("request.headers.get('origin')")
    expect(src).toContain('status: 403')
  })

  it('redirects with 303, so the login page is not a resubmit of the POST', () => {
    // Relative, never built from request.url: on Netlify that can be the deploy's own host.
    expect(code(ROUTE)).toContain("redirectToPath('/login', 303)")
    expect(code(ROUTE)).not.toContain('request.url')
  })

  it('actually signs the session out before redirecting', () => {
    const src = code(ROUTE)
    const out = src.indexOf('supabase.auth.signOut()')
    const redirect = src.indexOf('redirectToPath(')
    expect(out).toBeGreaterThan(-1)
    expect(redirect).toBeGreaterThan(out)
  })
})

describe('an unhandled error is never a dead end', () => {
  it('both boundaries exist', () => {
    expect(existsSync(join(process.cwd(), 'src/app/global-error.tsx')), 'global-error.tsx').toBe(true)
    expect(existsSync(join(process.cwd(), 'src/app/(dashboard)/error.tsx')), '(dashboard)/error.tsx').toBe(true)
  })

  it('global-error brings its own document, since it renders outside the root layout', () => {
    const src = read('src/app/global-error.tsx')
    expect(src).toContain('<html')
    expect(src).toContain('<body')
    // No Tailwind there: the stylesheet belongs to the layout it replaced.
    expect(src).toContain('plain')
  })

  it('recognises the stale-build error and reloads once, not in a loop', () => {
    const src = code(RECOVERY)
    expect(src).toMatch(/Server Action .*was not found on the server/)
    expect(src).toContain('Failed to find Server Action')
    expect(src).toContain('window.location.reload()')
    // The guard that stops a reload loop.
    expect(src).toContain('sessionStorage.getItem(RELOAD_MARK)')
    expect(src).toContain('RELOAD_WINDOW_MS')
    expect(src).toMatch(/Date\.now\(\) - last < RELOAD_WINDOW_MS/)
  })

  it('says what happened in words a person can act on', () => {
    const src = read(RECOVERY)
    expect(src).toContain('The Hub was updated')
    expect(src).toContain('Reload')
  })

  it('never blames the person or shows a raw stack', () => {
    const src = read(RECOVERY)
    expect(src).not.toMatch(/error\.stack/)
    expect(src).not.toMatch(/\{error\.message\}/)
  })
})
