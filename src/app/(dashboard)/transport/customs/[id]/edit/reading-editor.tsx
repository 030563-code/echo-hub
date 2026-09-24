'use client'
// page-state: none (the durable copy is the bill's reading; Save writes the whole package at once,
// and Claude's first reading is kept beside it)

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { saveCustomsReading } from '@/app/actions/customs/bills'
import { checkPackage } from '@/lib/customs/checks'
import { customsPackageSchema, type CustomsPackage, type EntryLine, type EntrySummary, type HtsRow } from '@/lib/customs/nippon-invoice'

/**
 * Put a reading right by hand: a misread figure, or the entry summary typed from a 7501 that came
 * on its own. The checks run as it is typed, so "adds up" can be seen before it is saved.
 */

interface HtsDraft {
  key: string
  code: string
  ratePct: string
  amount: string
  base: HtsRow | null
}
interface LineDraft {
  key: string
  lineNo: string
  invoiceNumber: string
  enteredValue: string
  mpf: string
  hts: HtsDraft[]
  base: EntryLine | null
}
interface ChargeDraft {
  key: string
  label: string
  amount: string
}
interface Draft {
  invoiceNumber: string
  invoiceDate: string
  invoiceTotal: string
  deliveredTo: string
  charges: ChargeDraft[]
  hasEntry: boolean
  entryNumber: string
  entryDate: string
  totalEnteredValue: string
  dutyTotal: string
  taxTotal: string
  otherTotal: string
  total: string
  mpfTotal: string
  hmfTotal: string
  countryOfOrigin: string
  lines: LineDraft[]
  spotId: string
  containers: string
}

let seq = 0
const key = () => `k${++seq}`
const str = (n: number | null | undefined) => (n == null ? '' : String(n))
const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')))
const pctOf = (rate: number | null) => (rate == null ? '' : String(Math.round(rate * 1_000_000) / 10_000))

function toDraft(pkg: CustomsPackage): Draft {
  const e = pkg.entry
  return {
    invoiceNumber: pkg.invoice.invoice_number,
    invoiceDate: pkg.invoice.invoice_date,
    invoiceTotal: str(pkg.invoice.total),
    deliveredTo: pkg.invoice.delivered_to ?? '',
    charges: pkg.invoice.charges.map((c) => ({ key: key(), label: c.label, amount: str(c.amount) })),
    hasEntry: Boolean(e),
    entryNumber: e?.entry_number ?? '',
    entryDate: e?.entry_date ?? '',
    totalEnteredValue: str(e?.total_entered_value),
    dutyTotal: str(e?.duty_total),
    taxTotal: str(e?.tax_total ?? 0),
    otherTotal: str(e?.other_total ?? 0),
    total: str(e?.total),
    mpfTotal: str(e?.mpf_total),
    hmfTotal: str(e?.hmf_total),
    countryOfOrigin: e?.country_of_origin ?? '',
    lines: (e?.lines ?? []).map((l) => ({
      key: key(),
      lineNo: l.line_no,
      invoiceNumber: l.invoice_number ?? '',
      enteredValue: str(l.entered_value),
      mpf: str(l.mpf),
      hts: l.hts.map((h) => ({ key: key(), code: h.code, ratePct: pctOf(h.rate), amount: str(h.amount), base: h })),
      base: l,
    })),
    spotId: pkg.waybill.spot_id ?? '',
    containers: pkg.waybill.container_numbers.join(', '),
  }
}

/** The draft as a package, for the schema to judge. Fields the form does not show are carried over. */
function toPackage(d: Draft, base: CustomsPackage): unknown {
  const entry: Partial<EntrySummary> | null = d.hasEntry
    ? {
        ...(base.entry ?? {}),
        entry_number: d.entryNumber,
        entry_date: d.entryDate,
        total_entered_value: num(d.totalEnteredValue) as number,
        duty_total: num(d.dutyTotal) as number,
        tax_total: num(d.taxTotal) ?? 0,
        other_total: num(d.otherTotal) ?? 0,
        total: num(d.total) as number,
        mpf_total: num(d.mpfTotal),
        hmf_total: num(d.hmfTotal),
        country_of_origin: d.countryOfOrigin || null,
        lines: d.lines.map((l) => ({
          ...(l.base ?? {}),
          line_no: l.lineNo,
          invoice_number: l.invoiceNumber || null,
          entered_value: num(l.enteredValue) as number,
          mpf: num(l.mpf),
          hts: l.hts.map((h) => {
            const rate = h.ratePct.trim() === '' ? null : Number(h.ratePct) / 100
            // A changed rate drops the printed text, so the page shows the figure that is used.
            const keepText = h.base && h.base.rate === rate
            return {
              code: h.code,
              description: h.base?.description ?? null,
              rate,
              rate_text: keepText ? h.base!.rate_text : null,
              amount: num(h.amount) as number,
            }
          }),
          charges: l.base?.charges ?? null,
        })) as EntryLine[],
        value_builds: base.entry?.value_builds ?? [],
      }
    : null
  return {
    ...base,
    invoice: {
      ...base.invoice,
      invoice_number: d.invoiceNumber,
      invoice_date: d.invoiceDate,
      total: num(d.invoiceTotal) as number,
      delivered_to: d.deliveredTo || null,
      charges: d.charges.map((c) => ({ label: c.label, amount: num(c.amount) as number })),
    },
    entry,
    waybill: {
      ...base.waybill,
      spot_id: d.spotId.trim() || null,
      container_numbers: d.containers
        .split(/[,;\n]+/)
        .map((c) => c.trim().toUpperCase().replace(/\s+/g, ''))
        .filter(Boolean),
    },
  }
}

const input = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none'
const amountInput = `${input} text-right tabular-nums`

function Box({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-gray-500">{label}</span>
      {children}
    </label>
  )
}

export default function ReadingEditor({ billId, pkg, draftInXero }: { billId: string; pkg: CustomsPackage; draftInXero: boolean }) {
  const [d, setD] = useState<Draft>(() => toDraft(pkg))
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const setLine = (lineKey: string, patch: Partial<LineDraft>) =>
    setD((x) => ({ ...x, lines: x.lines.map((l) => (l.key === lineKey ? { ...l, ...patch } : l)) }))
  const setHts = (lineKey: string, htsKey: string, patch: Partial<HtsDraft>) =>
    setD((x) => ({
      ...x,
      lines: x.lines.map((l) => (l.key === lineKey ? { ...l, hts: l.hts.map((h) => (h.key === htsKey ? { ...h, ...patch } : h)) } : l)),
    }))

  // The checks, worked again on every keystroke, the same way the bill page works them.
  const verdict = useMemo(() => {
    const parsed = customsPackageSchema.safeParse(toPackage(d, pkg))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { ok: false as const, message: `${issue?.path.join(' ') || 'The reading'}: ${issue?.message ?? 'not complete'}` }
    }
    return { ok: true as const, check: checkPackage(parsed.data) }
  }, [d, pkg])

  function save() {
    startTransition(async () => {
      try {
        const res = await saveCustomsReading(billId, toPackage(d, pkg))
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        router.push(`/transport/customs/${billId}`)
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  return (
    <div className="space-y-5">
      {draftInXero && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          The draft bill is already in Xero, made from the reading as it was. A correction here does not change it: change the
          draft in Xero as well before approving.
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Nippon Express&apos;s invoice
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Box label="Invoice number">
            <input value={d.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} className={input} />
          </Box>
          <Box label="Date">
            <input type="date" value={d.invoiceDate} onChange={(e) => set('invoiceDate', e.target.value)} className={input} />
          </Box>
          <Box label="Invoice total">
            <input inputMode="decimal" value={d.invoiceTotal} onChange={(e) => set('invoiceTotal', e.target.value)} aria-label="Invoice total" className={amountInput} />
          </Box>
          <Box label="Delivered to">
            <input value={d.deliveredTo} onChange={(e) => set('deliveredTo', e.target.value)} className={input} />
          </Box>
        </div>
        <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-gray-400">Charges</p>
        <div className="space-y-2">
          {d.charges.map((c, i) => (
            <div key={c.key} className="flex items-end gap-2">
              <Box label={i === 0 ? 'What for' : ''} className="flex-1">
                <input
                  value={c.label}
                  onChange={(e) => set('charges', d.charges.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)))}
                  aria-label={`Charge ${i + 1}`}
                  className={input}
                />
              </Box>
              <Box label={i === 0 ? 'Amount' : ''} className="w-36">
                <input
                  inputMode="decimal"
                  value={c.amount}
                  onChange={(e) => set('charges', d.charges.map((x) => (x.key === c.key ? { ...x, amount: e.target.value } : x)))}
                  aria-label={`Charge ${i + 1} amount`}
                  className={amountInput}
                />
              </Box>
              <button
                type="button"
                onClick={() => set('charges', d.charges.filter((x) => x.key !== c.key))}
                aria-label={`Remove charge ${i + 1}`}
                className="mb-0.5 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => set('charges', [...d.charges, { key: key(), label: '', amount: '' }])}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Plus className="h-3.5 w-3.5" /> A charge
        </button>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            CBP entry summary
          </h2>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={d.hasEntry} onChange={(e) => set('hasEntry', e.target.checked)} />
            This bill has an entry summary (7501)
          </label>
        </div>
        {d.hasEntry && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Box label="Entry number">
                <input value={d.entryNumber} onChange={(e) => set('entryNumber', e.target.value)} placeholder="510 0000000-0" className={input} />
              </Box>
              <Box label="Entry date">
                <input type="date" value={d.entryDate} onChange={(e) => set('entryDate', e.target.value)} className={input} />
              </Box>
              <Box label="Country of origin">
                <input value={d.countryOfOrigin} onChange={(e) => set('countryOfOrigin', e.target.value)} placeholder="SK" className={input} />
              </Box>
              <Box label="Total entered value (block 39)">
                <input inputMode="decimal" value={d.totalEnteredValue} onChange={(e) => set('totalEnteredValue', e.target.value)} className={amountInput} />
              </Box>
              <Box label="Duty (block 41)">
                <input inputMode="decimal" value={d.dutyTotal} onChange={(e) => set('dutyTotal', e.target.value)} className={amountInput} />
              </Box>
              <Box label="Tax (block 42)">
                <input inputMode="decimal" value={d.taxTotal} onChange={(e) => set('taxTotal', e.target.value)} className={amountInput} />
              </Box>
              <Box label="Other, the fees (block 43)">
                <input inputMode="decimal" value={d.otherTotal} onChange={(e) => set('otherTotal', e.target.value)} className={amountInput} />
              </Box>
              <Box label="Total (block 44)">
                <input inputMode="decimal" value={d.total} onChange={(e) => set('total', e.target.value)} className={amountInput} />
              </Box>
              <Box label="Processing fee, MPF (499)">
                <input inputMode="decimal" value={d.mpfTotal} onChange={(e) => set('mpfTotal', e.target.value)} className={amountInput} />
              </Box>
              <Box label="Harbor fee, HMF (501)">
                <input inputMode="decimal" value={d.hmfTotal} onChange={(e) => set('hmfTotal', e.target.value)} className={amountInput} />
              </Box>
            </div>

            <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-gray-400">Lines</p>
            <div className="space-y-3">
              {d.lines.map((l, i) => (
                <div key={l.key} className="rounded-lg border border-gray-200 p-3">
                  <div className="grid gap-3 sm:grid-cols-[6rem_1fr_10rem_8rem_auto]">
                    <Box label="Line">
                      <input value={l.lineNo} onChange={(e) => setLine(l.key, { lineNo: e.target.value })} aria-label={`Line ${i + 1} number`} className={input} />
                    </Box>
                    <Box label="Group invoice">
                      <input
                        value={l.invoiceNumber}
                        onChange={(e) => setLine(l.key, { invoiceNumber: e.target.value })}
                        aria-label={`Line ${i + 1} Group invoice`}
                        placeholder="EBGS..."
                        className={input}
                      />
                    </Box>
                    <Box label="Entered value">
                      <input
                        inputMode="decimal"
                        value={l.enteredValue}
                        onChange={(e) => setLine(l.key, { enteredValue: e.target.value })}
                        aria-label={`Line ${i + 1} entered value`}
                        className={amountInput}
                      />
                    </Box>
                    <Box label="MPF">
                      <input
                        inputMode="decimal"
                        value={l.mpf}
                        onChange={(e) => setLine(l.key, { mpf: e.target.value })}
                        aria-label={`Line ${i + 1} MPF`}
                        className={amountInput}
                      />
                    </Box>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => set('lines', d.lines.filter((x) => x.key !== l.key))}
                        aria-label={`Remove line ${i + 1}`}
                        className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
                    {l.hts.map((h, j) => (
                      <div key={h.key} className="grid items-end gap-2 sm:grid-cols-[1fr_8rem_10rem_auto]">
                        <Box label={j === 0 ? 'HTS heading' : ''}>
                          <input
                            value={h.code}
                            onChange={(e) => setHts(l.key, h.key, { code: e.target.value })}
                            aria-label={`Line ${i + 1} heading ${j + 1}`}
                            placeholder="3925.90.0000"
                            className={`${input} tabular-nums`}
                          />
                        </Box>
                        <Box label={j === 0 ? 'Rate (%)' : ''}>
                          <input
                            inputMode="decimal"
                            value={h.ratePct}
                            onChange={(e) => setHts(l.key, h.key, { ratePct: e.target.value })}
                            aria-label={`Line ${i + 1} heading ${j + 1} rate`}
                            className={amountInput}
                          />
                        </Box>
                        <Box label={j === 0 ? 'Duty' : ''}>
                          <input
                            inputMode="decimal"
                            value={h.amount}
                            onChange={(e) => setHts(l.key, h.key, { amount: e.target.value })}
                            aria-label={`Line ${i + 1} heading ${j + 1} duty`}
                            className={amountInput}
                          />
                        </Box>
                        <button
                          type="button"
                          onClick={() => setLine(l.key, { hts: l.hts.filter((x) => x.key !== h.key) })}
                          aria-label={`Remove line ${i + 1} heading ${j + 1}`}
                          className="mb-0.5 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setLine(l.key, { hts: [...l.hts, { key: key(), code: '', ratePct: '', amount: '', base: null }] })}
                      className="inline-flex items-center gap-1 text-sm font-medium text-[#025945] hover:underline"
                    >
                      <Plus className="h-3.5 w-3.5" /> A heading
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                set('lines', [
                  ...d.lines,
                  {
                    key: key(),
                    lineNo: String(d.lines.length + 1).padStart(3, '0'),
                    invoiceNumber: '',
                    enteredValue: '',
                    mpf: '',
                    hts: [{ key: key(), code: '', ratePct: '', amount: '', base: null }],
                    base: null,
                  },
                ])
              }
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" /> A line
            </button>
          </>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Sea waybill
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Box label="SPOT ID">
            <input value={d.spotId} onChange={(e) => set('spotId', e.target.value)} inputMode="numeric" className={`${input} tabular-nums`} />
          </Box>
          <Box label="Container numbers">
            <input value={d.containers} onChange={(e) => set('containers', e.target.value)} placeholder="ABCU1234567, separated by commas" className={`${input} uppercase`} />
          </Box>
        </div>
      </section>

      <div className="sticky bottom-0 z-10 -mx-1 rounded-xl border border-gray-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {verdict.ok ? (
            verdict.check.checks.length === 0 ? (
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Adds up.
              </p>
            ) : (
              <div className="text-sm">
                <p className={`font-medium ${verdict.check.worst === 'error' ? 'text-red-800' : 'text-amber-800'}`}>
                  {verdict.check.worst === 'error' ? 'Does not add up yet:' : 'Adds up, with something to look at:'}
                </p>
                <ul className="mt-0.5 list-disc pl-5 text-gray-700">
                  {verdict.check.checks.slice(0, 3).map((c, i) => (
                    <li key={i}>{c.message}</li>
                  ))}
                  {verdict.check.checks.length > 3 && <li>and {verdict.check.checks.length - 3} more</li>}
                </ul>
              </div>
            )
          ) : (
            <p className="text-sm text-gray-600">Not complete yet: {verdict.message}</p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/transport/customs/${billId}`)}
              disabled={pending}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending || !verdict.ok}
              className="rounded-lg bg-[#025945] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
            >
              {pending ? 'Saving' : 'Save the reading'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
