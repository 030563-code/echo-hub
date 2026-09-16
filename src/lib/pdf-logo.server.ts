import 'server-only'

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The Echo Barrier wordmark for a PDF rendered on the SERVER.
 *
 * The browser gets it with fetch("/logo.jpg") (pdf-brand.ts). A server render
 * has no origin to fetch from, so it reads the same file off disk. Lifted out of
 * the invoice renderer on 16 Sep 2026, unchanged, when the purchase order PDF
 * needed it too: one copy of "where the logo lives", not two that can drift.
 *
 * `undefined` means not tried yet, `null` means tried and failed. A failure
 * costs the logo, never the document.
 */
let cache: string | null | undefined

export async function serverLogoDataUrl(): Promise<string | undefined> {
  if (cache !== undefined) return cache ?? undefined
  try {
    const bytes = await readFile(path.join(process.cwd(), 'public', 'logo.jpg'))
    cache = `data:image/jpeg;base64,${bytes.toString('base64')}`
  } catch (error) {
    console.error('PDF: logo could not be read from public/logo.jpg', error)
    cache = null
  }
  return cache ?? undefined
}
