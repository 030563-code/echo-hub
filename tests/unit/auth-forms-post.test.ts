import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A credential form never falls back to a GET.
 *
 * 16 Sep 2026: the login form had no method attribute. A Sign In pressed before
 * React had hydrated (a slow connection is enough) did the browser's default,
 * a GET, and the password went into the URL, the browser history and the
 * request logs. With method="post" the pre-hydration fallback carries the
 * fields in the body instead; once hydrated, onSubmit prevents the default.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('forms that carry a password or a profile post, never get', () => {
  for (const file of ['src/app/(auth)/login/page.tsx', 'src/app/(auth)/onboarding/onboarding-form.tsx']) {
    it(`${file}`, () => {
      const forms = read(file).match(/<form\b[^>]*>/g) ?? []
      expect(forms.length).toBeGreaterThan(0)
      for (const tag of forms) expect(tag, tag).toMatch(/\bmethod="post"/)
    })
  }
})
