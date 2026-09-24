import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPackage } from '@/lib/customs/checks'
import { customsPackageSchema } from '@/lib/customs/nippon-invoice'
import { checksChip, checksFingerprint, isSignedOff, listRow, type CustomsBillFacts } from '@/lib/customs/view'

/**
 * Dean, 24 Sep 2026: "Some of the things say need a look but theres no way to edit in the Hub."
 * Dave signs a flag off with a word on why; the sign-off holds while the checks are the ones he
 * looked at. Invented bill: the repository is public.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

// A bill for storage only: no duty on it and no entry summary, which the checks flag as a warning.
const STORAGE_ONLY = customsPackageSchema.parse({
  invoice: {
    invoice_number: 'NEU-0002',
    invoice_date: '2026-04-01',
    total: 350,
    charges: [
      { label: 'STORAGE', amount: 200 },
      { label: 'EXAM FEE', amount: 150 },
    ],
  },
})

describe('what a bill was signed off against', () => {
  it('is the same whichever order the checks come in', () => {
    const check = checkPackage(STORAGE_ONLY)
    expect(check.worst).toBe('warn')
    const reversed = { ...check, checks: [...check.checks].reverse() }
    expect(checksFingerprint(reversed)).toBe(checksFingerprint(check))
  })

  it('holds while the checks are the same, and lapses when the reading changes them', () => {
    const fingerprint = checksFingerprint(checkPackage(STORAGE_ONLY))
    expect(isSignedOff(checkPackage(STORAGE_ONLY), fingerprint)).toBe(true)
    // A corrected figure that breaks a sum is a different set of checks.
    const changed = customsPackageSchema.parse({ ...STORAGE_ONLY, invoice: { ...STORAGE_ONLY.invoice, total: 360 } })
    expect(isSignedOff(checkPackage(changed), fingerprint)).toBe(false)
    expect(isSignedOff(checkPackage(STORAGE_ONLY), null)).toBe(false)
  })

  it('is nothing to sign off on a bill that adds up', () => {
    const fine = checkPackage(STORAGE_ONLY)
    const ok = { ...fine, checks: [], worst: 'ok' as const }
    expect(isSignedOff(ok, checksFingerprint(ok))).toBe(false)
  })
})

describe('the chip on a signed-off bill', () => {
  it('says Checked, in green, so it leaves the "need a look" count', () => {
    const check = checkPackage(STORAGE_ONLY)
    expect(checksChip(check)).toEqual({ label: 'Needs a look', tone: 'amber' })
    expect(checksChip(check, checksFingerprint(check))).toEqual({ label: 'Checked', tone: 'green' })

    const facts: CustomsBillFacts = {
      id: 'x',
      source: 'xero_history',
      ocr_status: 'done',
      ocr_error: null,
      extraction: STORAGE_ONLY,
      invoice_number: 'NEU-0002',
      invoice_date: '2026-04-01',
      invoice_total: 350,
      customs_total: null,
      duplicate_of: null,
      spot_id: null,
      xero_invoice_id: null,
      xero_status: null,
      xero_error: null,
      file_name: 'x.pdf',
      created_at: '2026-04-01T00:00:00Z',
    }
    expect(listRow(facts).checks?.tone).toBe('amber')
    expect(listRow({ ...facts, reviewed_checks: checksFingerprint(check) }).checks).toEqual({ label: 'Checked', tone: 'green' })
  })
})

describe('the actions that correct a bill', () => {
  it('each ask for customs.manage, and a corrected reading must have the shape Claude’s must', () => {
    const source = read('src/app/actions/customs/bills.ts')
    const exported = source.match(/^export async function \w+/gm) ?? []
    expect(exported.length).toBe(7)
    expect((source.match(/await gate\(/g) ?? []).length).toBe(exported.length)
    expect(source).toContain('customsPackageSchema.safeParse(extraction)')
    const store = read('src/lib/customs/store.server.ts')
    expect(store).toContain("if (check.worst === 'ok') return { ok: false, error: 'Nothing on this bill is flagged.' }")
    // Claude's first reading is kept, and a second correction does not overwrite it.
    expect(store).toContain('extraction_original: row.extraction_original ?? row.extraction')
  })
})
