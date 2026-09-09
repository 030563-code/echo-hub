import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { INCOTERMS, MODALITIES, CATEGORIES, DIRECTIONS, PACKAGE_TYPES } from '@/lib/cargo-request'

/**
 * Nothing reaches Cargo Partner without a person reading it first.
 *
 * Dean, 9 Sep 2026. These are rules about the shape of the code, because the
 * failure they guard against is not a wrong value today, it is a future edit
 * that quietly puts the send back on the factory's button or writes to the
 * forwarder's API.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const ACTION = 'src/app/actions/purchase-orders/cargo-request.ts'
const NOTIFY = 'src/app/actions/purchase-orders/notify-cargo-partner.ts'

describe('releasing a shipment request is claimed, not labelled', () => {
  const source = read(ACTION)

  it('claims the send in ONE conditional update, so two clicks cannot ask twice', () => {
    // A freight forwarder asked twice for the same container is a real
    // operational problem, and a disabled button only guards the polite case.
    expect(source).toMatch(/sent_at: nowIso[\s\S]{0,200}\.is\('sent_at', null\)[\s\S]{0,120}\.select\('po_id'\)/)
    expect(source).toContain('already been sent')
  })

  it('claims BEFORE it posts, and hands the claim back when nothing went out', () => {
    const claim = source.indexOf("sent_at: nowIso")
    const post = source.indexOf('notifyCargoPartnerReady(')
    expect(claim).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(claim)
    expect(source).toMatch(/if \(!sent\.sent\)[\s\S]{0,400}sent_at: null/)
  })

  it('refuses to edit a request that has already gone', () => {
    expect(source).toMatch(/saveCargoRequest[\s\S]{0,900}\.is\('sent_at', null\)/)
  })

  it('needs po.create, like every other button that reaches a third party', () => {
    expect(source).toContain("capabilities.has('po.create')")
  })

  it('refuses to send a request that names nobody', () => {
    expect(source).toMatch(/if \(!draft\.to\)/)
  })
})

describe('the screen and the validator cannot drift apart', () => {
  it('validates against the same lists the dropdowns are built from', () => {
    const source = read(ACTION)
    for (const name of ['INCOTERMS', 'MODALITIES', 'CATEGORIES', 'DIRECTIONS', 'PACKAGE_TYPES']) {
      expect(source).toContain(`z.enum(${name})`)
    }
  })

  it('carries the terms Cargo Partner actually publish', () => {
    // From their own Transport specification, not invented. DAP and DDP are the
    // two anyone here is likely to pick, so a list missing them is a broken list.
    expect(INCOTERMS).toContain('DAP')
    expect(INCOTERMS).toContain('DDP')
    expect(INCOTERMS).toContain('EXW')
    expect(INCOTERMS.length).toBe(15)
    expect(MODALITIES).toContain('SEA')
    expect(CATEGORIES).toContain('FCL')
    expect(DIRECTIONS).toContain('EXPORT')
    expect(PACKAGE_TYPES[0]).toBe('PAL')
  })
})

describe('the Hub still decides who gets the email', () => {
  it('runs the approved addresses through the test switch rather than trusting the stored ones', () => {
    // Otherwise an address typed into the review screen weeks ago would reach a
    // forwarder while everybody believed the override was on.
    expect(read(NOTIFY)).toMatch(/resolveRecipients\(\{ to: draft\.to, cc: draft\.cc \}\)/)
  })
})

describe('nothing in the Hub writes to the Cargo Partner API', () => {
  it('makes no transport order, document or event anywhere in src', () => {
    const files = walk(join(process.cwd(), 'src'))
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return /client-transport-orders|\/transport\/v1\/(orders|documents|events)/.test(source)
    })
    expect(offenders.map((f) => f.replace(`${process.cwd()}/`, ''))).toEqual([])
  })

  it('finds the tree, so a bad path cannot make that vacuously pass', () => {
    expect(walk(join(process.cwd(), 'src')).length).toBeGreaterThan(50)
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}
