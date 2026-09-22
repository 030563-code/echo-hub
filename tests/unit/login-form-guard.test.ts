import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The sign-in form must not be submittable before React has attached to it.
 *
 * Dean, 22 Sep 2026: "we keep getting logged out sometimes."
 *
 * 🔴 One cause is this form, and it is not a session problem at all. Until React
 * hydrates, this is a plain HTML form carrying method="post" and no action. A
 * click posts it natively to /login, Next has no POST handler for that route,
 * and the person lands back on an EMPTY login form with nothing said. It is
 * indistinguishable from being signed out for no reason, and it happens on a
 * slow connection or a cold start. Reproduced twice against production while
 * chasing the report: the form came back blank, no error, no cookies set, and
 * no call to Supabase at all.
 *
 * Proven by the server-rendered HTML before and after:
 *   live site   <button type="submit">Sign In        clickable, posts natively
 *   this build  <button type="submit" disabled>Loading…
 *
 * The method="post" is NOT the bug and must stay: without it the native submit
 * is a GET and the browser puts the password in the URL, the history and every
 * request log on the way (16 Sep 2026). The fix is to make the button wait.
 */

const login = readFileSync(join(process.cwd(), 'src/app/(auth)/login/page.tsx'), 'utf8')

describe('the sign-in form waits for React before it can be submitted', () => {
  it('disables the button until the page has hydrated', () => {
    expect(login).toContain('disabled={loading || !ready}')
  })

  it('works out hydration without setting state in an effect', () => {
    // useSyncExternalStore returns the server snapshot during render and the
    // client one after hydration, in a single pass. setState in an effect does
    // the same thing a render later, and the React Compiler refuses it.
    expect(login).toContain('useSyncExternalStore')
    expect(login).not.toMatch(/useEffect\(\s*\(\)\s*=>\s*setReady/)
  })

  it('keeps method="post", so a native submit can never put the password in the URL', () => {
    expect(login).toContain('method="post"')
  })

  it('still says what went wrong when a sign-in is refused', () => {
    // The silent bounce is the thing being fixed; a real credential error must
    // still be shown rather than swallowed.
    expect(login).toContain('setError(')
    expect(login).toMatch(/\{error &&/)
  })
})
