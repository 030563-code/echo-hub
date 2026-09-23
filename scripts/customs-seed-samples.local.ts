/**
 * Local check of the Customs pipeline with the three real sample packages, 23 Sep 2026.
 *
 * Plays both n8n roles against a local dev server: hands the Hub each scan as a bill from history
 * (with its real Xero id, status and Dave's own line coding), then posts the reading, which is the
 * hand transcription in tests/fixtures/customs (every figure checked by the unit tests). The three
 * bills are among the 31 the history run reads anyway; that run skips them by file fingerprint.
 *
 * Usage: npx tsx scripts/customs-seed-samples.local.ts <dir with the three PDFs> <research json>
 * Reads CUSTOMS_INGEST_SECRET from .env.local and never prints it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_D0806, PACKAGE_D1518, PACKAGE_D8400 } from '../tests/fixtures/customs/nippon-packages'

const BASE = process.env.HUB_BASE_URL ?? 'http://localhost:3000'
const [pdfDir, researchPath] = process.argv.slice(2)
if (!pdfDir || !researchPath) throw new Error('usage: customs-seed-samples.local.ts <pdf dir> <research json>')

const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
const secret = env.match(/^CUSTOMS_INGEST_SECRET=(.+)$/m)?.[1]?.trim()
if (!secret) throw new Error('CUSTOMS_INGEST_SECRET is not in .env.local')
const auth = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }

type Line = { description: string; amount: number; accountCode: string | null }
const research = JSON.parse(readFileSync(researchPath, 'utf8'))
const bills: { number: string; invoiceId: string; status: string; lines: { description: string; lineAmount: number; accountCode: string }[] }[] =
  research.data.resultData.runData['Xero USA: Nippon bills summary'][0].data.main[0][0].json.bills
const groups = JSON.parse(readFileSync(researchPath.replace(/1790167026613/, '1790167251603'), 'utf8')).data.resultData.runData[
  'Group bills summary'
][0].data.main[0][0].json.bills as { number: string; lines: { d: string; amt: number; acct: string }[] }[]

const samples = [
  { pkg: PACKAGE_D1518, file: '26NEU-12G-D1518.pdf', groups: ['EBGS202610039', 'EBGS202610040'] },
  { pkg: PACKAGE_D0806, file: '26NEU-12G-D0806.pdf', groups: ['EBUK2026095'] },
  { pkg: PACKAGE_D8400, file: '26NEU-445-D8400.pdf', groups: ['EBGS202610015'] },
]

async function main() {
  for (const s of samples) {
    const number = s.pkg.invoice.invoice_number
    const bill = bills.find((b) => b.number === number)
    if (!bill) throw new Error(`${number} is not in the research output`)
    const xeroLines: Line[] = bill.lines.map((l) => ({ description: l.description, amount: l.lineAmount, accountCode: l.accountCode }))
    const pdf = readFileSync(join(pdfDir, s.file))

    const ingest = await fetch(`${BASE}/api/customs/ingest`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        source: 'xero_history',
        file_name: s.file,
        pdf_base64: pdf.toString('base64'),
        xero_invoice_id: bill.invoiceId,
        xero_status: bill.status,
        xero_lines: xeroLines,
      }),
    })
    const stored = (await ingest.json()) as { ok: boolean; id?: string; duplicate?: boolean; ocr?: string; error?: string }
    console.log(number, 'ingest', ingest.status, JSON.stringify({ ok: stored.ok, duplicate: stored.duplicate, ocr: stored.ocr, error: stored.error }))
    if (!stored.id) continue

    const groupBills = s.groups.map((g) => {
      const found = groups.find((b) => b.number === g)
      if (!found) throw new Error(`${g} is not in the research output`)
      return { number: g, lines: found.lines.map((l) => ({ description: l.d, amount: l.amt, accountCode: l.acct })) }
    })
    const extraction = await fetch(`${BASE}/api/customs/extraction`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        bill_id: stored.id,
        model: 'read by hand in Claude Code, 23 Sep 2026',
        extraction: s.pkg,
        group_bills: groupBills,
      }),
    })
    const outcome = await extraction.json()
    console.log(number, 'reading', extraction.status, JSON.stringify(outcome))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
