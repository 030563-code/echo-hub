import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EB_LOGO_ASPECT, EB_LOGO_GREEN_PNG } from '@/lib/eb-logo'

/**
 * The green wordmark on the two supplier documents. Dean, 18 Sep 2026: "Add
 * the echobarrier logo to the PO for branding ... which is the green one."
 */
describe('the embedded Echo Barrier logo', () => {
  it('is a real PNG, read straight out of the data URL', () => {
    const [header, b64] = EB_LOGO_GREEN_PNG.split(',')
    expect(header).toBe('data:image/png;base64')
    const bytes = Buffer.from(b64, 'base64')
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // Width and height live in the IHDR chunk, and the aspect constant must
    // describe THIS file, or a caller stating a width gets the wrong height.
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    expect(width).toBe(1181)
    expect(height).toBe(210)
    expect(EB_LOGO_ASPECT).toBeCloseTo(width / height, 6)
  })

  it('stays small enough to sit in a source file', () => {
    // 6 KB of PNG. The 940 KB guide is fetched for exactly the opposite reason.
    expect(EB_LOGO_GREEN_PNG.length).toBeLessThan(12_000)
  })

  it('is drawn on both documents the factory downloads, and compressed', () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
    for (const f of ['src/lib/supplier-spec-pdf.ts', 'src/lib/bamida-po-pdf.ts']) {
      expect(read(f), f).toContain("import { drawEbLogo } from '@/lib/eb-logo'")
      expect(read(f), f).toMatch(/drawEbLogo\(doc, (MARGIN|14), 8, 40\)/)
    }
    // Without a compression argument jsPDF stores the PNG uncompressed and
    // every document grows by half a megabyte (measured 18 Sep 2026).
    expect(read('src/lib/eb-logo.ts')).toContain("'eb-logo-green', 'MEDIUM')")
  })
})
