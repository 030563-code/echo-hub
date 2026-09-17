import 'server-only'

/**
 * The Slovak guide, attached to every email the factory gets.
 *
 * Dean, 17 Sep 2026: "can you attache the pdf document you made to each email if possible?"
 *
 * 🔴 BEST EFFORT, ALWAYS. A guide that cannot be read must never stop a purchase order reaching the
 * factory: every failure here returns null and the email goes without it. The order is the thing
 * that matters; the guide is a convenience.
 *
 * Fetched over HTTP from our own `public/` rather than read off disk or embedded as base64. A
 * serverless function's working directory is not a promise anybody makes, and a 940 KB base64
 * string in a source file is a source file nobody can read. Netlify serves this from the same
 * deploy that is running, so the guide can never be older than the Hub it describes.
 */

import { hubBaseUrl } from '@/lib/env'

/** Regenerate with tests/e2e/factory-guide-capture.spec.ts and tests/unit/factory-guide-pdf.test.ts. */
const GUIDE_PATH = '/guides/navod-pre-vyrobu.pdf'
const FILENAME = 'Echo Barrier Hub - navod pre vyrobu.pdf'
const TIMEOUT_MS = 8_000

export interface EmailAttachment {
  filename: string
  content_base64: string
}

export async function factoryGuideAttachment(): Promise<EmailAttachment | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${hubBaseUrl()}${GUIDE_PATH}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    // A guide that came back as an error page is not a guide.
    if (bytes.length < 10_000 || bytes.subarray(0, 4).toString() !== '%PDF') return null
    return { filename: FILENAME, content_base64: bytes.toString('base64') }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
