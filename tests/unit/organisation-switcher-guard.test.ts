import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The header flag switches organisation, and only through the one route.
 *
 * Dean, 16 Sep 2026: "you should be able to click on the flag at the top next
 * to Echo Barrier Hub to change the current loaded country."
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const SWITCHER = 'src/components/nav/organisation-switcher.tsx'
const SHELL = 'src/components/nav/shell.tsx'

describe('the header organisation switcher', () => {
  const source = read(SWITCHER)

  it('is the badge the header shows, so the badge tests keep reading it', () => {
    expect(read(SHELL)).toContain('<OrganisationSwitcher')
    expect(read(SHELL)).not.toContain('<FlagIcon')
    expect((source.match(/data-testid="active-organisation"/g) ?? []).length).toBe(2)
  })

  it('offers nothing to choose when there is one organisation', () => {
    expect(source).toMatch(/if \(organisations\.length < 2\) \{[\s\S]{0,300}<span[\s\S]{0,200}data-testid="active-organisation"/)
  })

  it('switches through the /org route with a full navigation, never a client transition', () => {
    // Plain anchors, like the sidebar: the cookie is set by the route and the
    // whole tree has to re-render under the new organisation.
    expect(source).toContain('href={`/org/${encodeURIComponent(code)}?next=${encodeURIComponent(next)}`}')
    expect(source).not.toMatch(/from 'next\/link'/)
    expect(source).not.toContain('router.push')
  })

  it('works out where to land from the path, through the pure helper', () => {
    expect(source).toContain('nextPathAfterSwitch(pathname, code)')
  })

  it('is a real menu: announced, closable, and marks the current one', () => {
    expect(source).toContain('aria-haspopup="menu"')
    expect(source).toContain('aria-expanded={open}')
    expect(source).toContain("e.key === 'Escape'")
    expect(source).toContain("aria-current={current ? 'true' : undefined}")
  })
})
