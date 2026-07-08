import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Creds } from './helpers'

interface PoFixture {
  id: string
  po_number: string
  master_ref: string | null
}

interface SroState {
  buyer: Creds
  worker: Creds
  receivePo: PoFixture
  bomPo: PoFixture
  cargoPo: PoFixture
}

let cached: SroState | null | undefined

/** Fixtures + scoped creds written by tests/e2e/_setup.mjs (null if not run). */
export function sroState(): SroState | null {
  if (cached !== undefined) return cached
  try {
    cached = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/e2e/.e2e-state.json'), 'utf8')) as SroState
  } catch {
    cached = null
  }
  return cached
}
