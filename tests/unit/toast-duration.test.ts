import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Hub messages stay long enough to read.
 *
 * Dean, 16 Sep 2026: "please make the hub messages stay longer it goes past
 * quick." Sonner's default is 4 seconds. Several Hub toasts carry information
 * that exists nowhere else on the screen, such as which address an email
 * actually reached, so four seconds is the difference between telling somebody
 * and not.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('toasts', () => {
  it('last well past sonner default, and can be dismissed by hand', () => {
    const layout = read('src/app/(dashboard)/layout.tsx')
    const tag = layout.slice(layout.indexOf('<Toaster'), layout.indexOf('/>', layout.indexOf('<Toaster')))
    expect(tag).toContain('closeButton')
    const duration = tag.match(/duration=\{([0-9_]+)\}/)
    expect(duration, 'Toaster has an explicit duration').toBeTruthy()
    expect(Number(String(duration?.[1]).replace(/_/g, ''))).toBeGreaterThanOrEqual(8000)
  })

  it('a warning that an outside party was not told never times out', () => {
    const approvals = read('src/app/(dashboard)/purchase-orders/approvals/approvals-client.tsx')
    expect(approvals).toContain('toast.warning(res.warning, { duration: Infinity })')
  })
})
