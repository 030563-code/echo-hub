import { describe, it, expect } from 'vitest'
import { NAV_ICON_NAMES, NAV_ITEMS } from '@/lib/capabilities'
import { NAV_ICONS } from '@/lib/nav-icons'

/**
 * The sidebar and the dashboard home used to keep separate icon maps with
 * separate silent fallbacks, so a nav item added to one and missed in the
 * other drew a plausible wrong glyph instead of failing. NAV_ICONS is now the
 * single map, and Record<NavIconName, LucideIcon> makes a missing entry a
 * compile error. These guard the other direction, which the type cannot see:
 * a NAV_ITEMS entry naming an icon that was never added to the list.
 */
describe('nav icons', () => {
  it('every NAV_ITEMS icon resolves to a real component', () => {
    for (const item of NAV_ITEMS) {
      expect(NAV_ICONS[item.icon], `${item.label} has no icon`).toBeTruthy()
    }
  })

  it('NAV_ICONS covers exactly NAV_ICON_NAMES', () => {
    expect(Object.keys(NAV_ICONS).sort()).toEqual([...NAV_ICON_NAMES].sort())
  })

  it('declares no icon that no nav item uses', () => {
    const used = new Set(NAV_ITEMS.map((i) => i.icon))
    const unused = NAV_ICON_NAMES.filter((name) => !used.has(name))
    expect(unused, `unused icons: ${unused.join(', ')}`).toEqual([])
  })
})
