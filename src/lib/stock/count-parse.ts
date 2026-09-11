/**
 * Parse a pasted or uploaded stock count into rows the count RPC accepts.
 *
 * Juraj's count arrives as a spreadsheet column pair, so the input is one
 * line per SKU: `EBH9NA,25`. Commas, semicolons and tabs all work because
 * every spreadsheet exports a different one. An optional header row is
 * skipped by looking at its second field: a header has no number there.
 *
 * Every problem is reported with its line number and the parse carries on,
 * so a 200-line paste with two typos shows two errors, not one at a time.
 * Duplicate SKUs are an error rather than a silent last-wins, because two
 * lines for one SKU means somebody counted it twice and the numbers differ.
 *
 * Pure. No imports.
 */

export interface CountRow {
  sku: string
  counted: number
}

export interface CountParseError {
  line: number
  message: string
}

export interface CountParseResult {
  rows: CountRow[]
  errors: CountParseError[]
}

const SEPARATOR = /[,;\t]/

export function parseCountInput(text: string): CountParseResult {
  const rows: CountRow[] = []
  const errors: CountParseError[] = []
  const seen = new Map<string, number>()

  const lines = String(text ?? '').split(/\r?\n/)
  lines.forEach((raw, index) => {
    const lineNo = index + 1
    const trimmed = raw.trim()
    if (trimmed === '') return

    const parts = trimmed.split(SEPARATOR).map((p) => p.trim().replace(/^"|"$/g, ''))
    const sku = (parts[0] ?? '').toUpperCase()
    const qtyText = parts[1] ?? ''

    // A header row: first line, and the quantity column is not a number.
    if (lineNo === 1 && rows.length === 0 && qtyText !== '' && Number.isNaN(Number(qtyText))) return

    if (sku === '') {
      errors.push({ line: lineNo, message: 'No SKU on this line' })
      return
    }
    if (qtyText === '') {
      errors.push({ line: lineNo, message: `${sku}: no quantity` })
      return
    }
    const counted = Number(qtyText)
    if (!Number.isFinite(counted)) {
      errors.push({ line: lineNo, message: `${sku}: "${qtyText}" is not a number` })
      return
    }
    if (counted < 0) {
      errors.push({ line: lineNo, message: `${sku}: a count cannot be negative` })
      return
    }
    const first = seen.get(sku)
    if (first !== undefined) {
      errors.push({ line: lineNo, message: `${sku}: already counted on line ${first}` })
      return
    }
    seen.set(sku, lineNo)
    rows.push({ sku, counted })
  })

  return { rows, errors }
}
