'use client'

// page-state: none (the document is saved to the ORDER, in po_spec_document, not to this
// person's page state. Two people editing one order must not each carry their own private copy
// of what the factory is going to be told to build.)

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Trash2, RotateCcw, Save, CheckCircle2, FileDown } from 'lucide-react'
import {
  saveSpecDocument,
  confirmSpecDocument,
  resetSpecDocument,
  type SpecEditorState,
} from '@/app/actions/purchase-orders/spec-document'
import { downloadSupplierPoPdf } from '@/app/actions/purchase-orders/download-supplier-po'
import { confirmButton, driftSentence, type SpecDraft, type SpecDraftProduct } from '@/lib/po-spec-draft'
import { colourOptionsFor, toColourOptions } from '@/lib/material-colours'

/**
 * The manufacturing specification as a form.
 *
 * Everything the factory reads is editable, because Dean's point was that there are "so many
 * variables": the Hub holds sixteen named specification fields and the real orders regularly need
 * a seventeenth. Rows are label and value rather than a fixed field list, so an extra requirement
 * is typed rather than waiting on a migration.
 *
 * NOTHING SAVES BY ITSELF. Every change sits in the browser until Save or Confirm is pressed, so a
 * mistyped quantity cannot reach the factory's download while somebody is still thinking about it.
 * Confirm writes the document AND signs it, because the commonest case is a generated document
 * that is already correct and that must not need a pointless edit before it can be signed.
 */

const input =
  'w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none focus:ring-1 focus:ring-[#025945]'
const label = 'block text-[11px] font-medium uppercase tracking-wide text-gray-500'
const ghost =
  'inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'

function iso(value: string | null) {
  return value ? value.slice(0, 10) : null
}

export default function SpecificationEditor({
  poId,
  initial,
}: {
  poId: string
  initial: SpecEditorState
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<SpecDraft>(initial.draft)
  const [dirty, setDirty] = useState(false)
  const [state, setState] = useState(initial)
  const [pending, start] = useTransition()
  const [downloading, setDownloading] = useState(false)

  const readOnly = !state.canEdit
  // The rule lives in po-spec-draft.ts and is unit tested: an unsigned document can ALWAYS be
  // signed, with or without an edit first.
  const signOff = confirmButton({ confirmedAt: state.confirmedAt, dirty, pending })
  // Which fabrics come in colours, and in which. Juraj, 22 Sep 2026: PC350FR and P200.
  const colours = toColourOptions(state.colourOptions)

  /** Every edit goes through here, so nothing can change the draft without marking it unsaved. */
  const edit = (next: SpecDraft) => {
    setDraft(next)
    setDirty(true)
  }
  const editProduct = (index: number, patch: Partial<SpecDraftProduct>) => {
    edit({
      ...draft,
      products: draft.products.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    })
  }

  /** Every write returns the new state, so the screen shows the database and not a guess. */
  function apply(result: Awaited<ReturnType<typeof saveSpecDocument>>, done: string) {
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setState(result.state)
    setDraft(result.state.draft)
    setDirty(false)
    toast.success(done)
    router.refresh()
  }

  function save() {
    start(async () => apply(await saveSpecDocument({ poId, draft }), 'Saved to the order'))
  }

  /**
   * 🔴 Confirm signs WHAT IS ON THE SCREEN, saved or not.
   *
   * Dean, 17 Sep 2026: "I cant press confirm as it is greyed out. I need to edit something and
   * then it appears what if the first one is correct?" He was right. Requiring a save first made
   * the commonest case, a generated document that is already correct, the one case you could not
   * sign without first making a pointless edit. The server writes the content and the signature in
   * one statement.
   */
  function confirm() {
    start(async () =>
      apply(await confirmSpecDocument({ poId, draft }), 'Specification confirmed'),
    )
  }

  function reset() {
    if (
      !window.confirm(
        'Rebuild this specification from the order and the standing product specifications? Every change made here, and any confirmation, is lost.',
      )
    )
      return
    start(async () => apply(await resetSpecDocument({ poId }), 'Rebuilt from the order'))
  }

  async function download() {
    setDownloading(true)
    try {
      const res = await downloadSupplierPoPdf({ poId, kind: 'specification' })
      if (!res.ok) throw new Error(res.error)
      const blob = new Blob([Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))], {
        type: 'application/pdf',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = res.filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not build the PDF')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="mt-6 space-y-5 pb-28">
      {/* ------------------------------------------------------------ status */}
      <section
        className={`rounded-lg border px-4 py-3 text-sm ${
          state.confirmedAt
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        {state.confirmedAt ? (
          <p className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Confirmed by {state.confirmedBy ?? 'someone'} on {iso(state.confirmedAt)}. The PDF
              prints their name instead of the unconfirmed warning. Changing anything here withdraws
              the confirmation, so it always belongs to the words that were read.
            </span>
          </p>
        ) : (
          <p>
            <strong>Not confirmed.</strong>{' '}
            {state.saved
              ? `Saved${state.updatedBy ? ` by ${state.updatedBy}` : ''}${iso(state.updatedAt) ? ` on ${iso(state.updatedAt)}` : ''}, but nobody has signed it off, so the PDF carries the unconfirmed warning.`
              : 'This was generated from the order and the standing product specifications, and nothing has been saved for this order yet. If it is already right, press Confirm specification: that saves it and signs it in one go. The PDF carries the unconfirmed warning until you do.'}
          </p>
        )}
      </section>

      {/* -------------------------------------------------------- order drift */}
      {state.drift.length > 0 && (
        <section className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <p className="font-medium">This document and the order no longer agree.</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {state.drift.map((d, i) => (
              <li key={i}>{driftSentence(d)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Nothing was changed for you. Edit the rows below, or rebuild from the order, which
            replaces everything here.
          </p>
        </section>
      )}

      {/* --------------------------------------------------------- destination */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <label className={label} htmlFor="destination">
          Destination
        </label>
        <input
          id="destination"
          className={`${input} mt-1.5 max-w-sm`}
          value={draft.destination ?? ''}
          disabled={readOnly}
          placeholder="Where the barriers are going"
          onChange={(e) => edit({ ...draft, destination: e.target.value || null })}
        />
        <p className="mt-1.5 text-xs text-gray-500">
          Printed at the top so the factory packs and labels to it.
        </p>
      </section>

      {/* ------------------------------------------------------------ products */}
      {draft.products.map((product, pi) => (
        <section key={product.model} className="rounded-lg border border-gray-200 bg-white">
          <header className="border-b border-gray-200 px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem]">
              <div>
                <label className={label}>Product</label>
                <input
                  className={`${input} mt-1`}
                  value={product.name}
                  disabled={readOnly}
                  onChange={(e) => editProduct(pi, { name: e.target.value })}
                />
              </div>
              <div>
                <label className={label}>Quantity</label>
                <input
                  className={`${input} mt-1`}
                  type="number"
                  min={0}
                  value={product.quantity}
                  disabled={readOnly}
                  onChange={(e) => editProduct(pi, { quantity: Number(e.target.value) || 0 })}
                />
              </div>
              <div>
                <label className={label}>Per pallet</label>
                <input
                  className={`${input} mt-1`}
                  type="number"
                  min={1}
                  value={product.packSize}
                  disabled={readOnly}
                  onChange={(e) => editProduct(pi, { packSize: Number(e.target.value) || 1 })}
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Model <span className="font-mono">{product.model}</span> ·{' '}
              {product.packSize > 0 ? Math.ceil(product.quantity / product.packSize) : 0} pallets
              {product.sourceDocument ? ` · standing values read from ${product.sourceDocument}` : ''}
            </p>
          </header>

          {/* --------------------------------------------------- materials */}
          <RowGroup
            title="Materials"
            hint="What goes into one barrier. The total is worked out from the quantity, so it can never disagree with it. A fabric that comes in colours has its colour chosen here, and the sheet prints it beside the material."
            readOnly={readOnly}
            onAdd={() =>
              editProduct(pi, {
                materials: [...product.materials, { code: '', description: '', perUnit: 0, total: 0 }],
              })
            }
          >
            {product.materials.length === 0 && <Empty>No materials on this product.</Empty>}
            {product.materials.map((m, mi) => {
              // The colours this material can be ordered in, by the family its code starts with.
              // Nothing for a material that is not a coloured fabric, so its row stays as it was.
              const options = colourOptionsFor(m.code, colours)
              return (
              <div key={mi} className="grid gap-2 sm:grid-cols-[8rem_1fr_9rem_6rem_2rem]">
                <input
                  className={input}
                  value={m.code}
                  placeholder="Code"
                  disabled={readOnly}
                  onChange={(e) =>
                    editProduct(pi, {
                      materials: product.materials.map((x, i) =>
                        i === mi ? { ...x, code: e.target.value } : x,
                      ),
                    })
                  }
                />
                <input
                  className={input}
                  value={m.description}
                  placeholder="Material"
                  disabled={readOnly}
                  onChange={(e) =>
                    editProduct(pi, {
                      materials: product.materials.map((x, i) =>
                        i === mi ? { ...x, description: e.target.value } : x,
                      ),
                    })
                  }
                />
                {options.length > 0 ? (
                  <select
                    className={`${input} ${m.colour ? '' : 'border-amber-300 text-amber-800'}`}
                    value={m.colour ?? ''}
                    aria-label={`Colour of ${m.code}`}
                    title="The colour this order wants this fabric in"
                    disabled={readOnly}
                    onChange={(e) =>
                      editProduct(pi, {
                        materials: product.materials.map((x, i) =>
                          i === mi ? { ...x, colour: e.target.value || undefined } : x,
                        ),
                      })
                    }
                  >
                    <option value="">Colour not chosen</option>
                    {/* A colour typed before it was an option, or since removed, stays selectable
                        rather than silently turning into "not chosen" on a signed document. */}
                    {m.colour && !options.includes(m.colour) && <option value={m.colour}>{m.colour}</option>}
                    {options.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span aria-hidden className="hidden sm:block" />
                )}
                <input
                  className={input}
                  type="number"
                  step="0.001"
                  min={0}
                  value={m.perUnit}
                  title="Per barrier"
                  disabled={readOnly}
                  onChange={(e) =>
                    editProduct(pi, {
                      materials: product.materials.map((x, i) =>
                        i === mi ? { ...x, perUnit: Number(e.target.value) || 0 } : x,
                      ),
                    })
                  }
                />
                <RemoveButton
                  readOnly={readOnly}
                  title="Remove this material"
                  onClick={() =>
                    editProduct(pi, { materials: product.materials.filter((_, i) => i !== mi) })
                  }
                />
              </div>
              )
            })}
          </RowGroup>

          {/* ---------------------------------------------- specification */}
          <RowGroup
            title="Specification"
            hint="One row per requirement. Add a row for anything this order needs that the standing specification does not carry."
            readOnly={readOnly}
            onAdd={() => editProduct(pi, { specRows: [...product.specRows, { label: '', value: '' }] })}
          >
            {product.specRows.length === 0 && (
              <Empty>
                No specification rows. The PDF will say no specification is held for this product.
              </Empty>
            )}
            {product.specRows.map((r, ri) => (
              <div key={ri} className="grid gap-2 sm:grid-cols-[13rem_1fr_2rem]">
                <input
                  className={input}
                  value={r.label}
                  placeholder="PVC, Goretex, Pallet type…"
                  disabled={readOnly}
                  onChange={(e) =>
                    editProduct(pi, {
                      specRows: product.specRows.map((x, i) =>
                        i === ri ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                />
                <textarea
                  className={`${input} min-h-[2.25rem] resize-y`}
                  rows={1}
                  value={r.value}
                  placeholder="What the factory must use"
                  disabled={readOnly}
                  onChange={(e) =>
                    editProduct(pi, {
                      specRows: product.specRows.map((x, i) =>
                        i === ri ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                />
                <RemoveButton
                  readOnly={readOnly}
                  title="Remove this row"
                  onClick={() =>
                    editProduct(pi, { specRows: product.specRows.filter((_, i) => i !== ri) })
                  }
                />
              </div>
            ))}
          </RowGroup>

          {/* -------------------------------------------------- the bullets */}
          <RowGroup
            title="Specific requirements"
            hint="Printed as a bulleted list under the specification table."
            readOnly={readOnly}
            onAdd={() => editProduct(pi, { bullets: [...product.bullets, ''] })}
          >
            {product.bullets.length === 0 && <Empty>No specific requirements.</Empty>}
            {product.bullets.map((b, bi) => (
              <div key={bi} className="grid gap-2 sm:grid-cols-[1fr_2rem]">
                <textarea
                  className={`${input} min-h-[2.25rem] resize-y`}
                  rows={1}
                  value={b}
                  disabled={readOnly}
                  onChange={(e) =>
                    editProduct(pi, {
                      bullets: product.bullets.map((x, i) => (i === bi ? e.target.value : x)),
                    })
                  }
                />
                <RemoveButton
                  readOnly={readOnly}
                  title="Remove this requirement"
                  onClick={() =>
                    editProduct(pi, { bullets: product.bullets.filter((_, i) => i !== bi) })
                  }
                />
              </div>
            ))}
          </RowGroup>
        </section>
      ))}

      {/* -------------------------------------------------------------- packing */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Packing and finishing</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(
            [
              ['pallets', 'Pallets'],
              ['palletCovers', 'Pallet covers'],
              ['metalFrames', 'Metal frames'],
            ] as const
          ).map(([key, text]) => (
            <div key={key}>
              <label className={label}>{text}</label>
              <input
                className={`${input} mt-1`}
                type="number"
                min={0}
                value={draft.packing[key]}
                disabled={readOnly}
                onChange={(e) =>
                  edit({
                    ...draft,
                    packing: { ...draft.packing, [key]: Number(e.target.value) || 0 },
                  })
                }
              />
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- actions */}
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
          {readOnly ? (
            <p className="text-sm text-gray-500">
              You can read this specification. Changing it needs the bill of materials capability.
            </p>
          ) : (
            <>
              <button
                onClick={save}
                disabled={pending || !dirty}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {dirty ? 'Save without confirming' : 'Saved'}
              </button>
              <button
                onClick={confirm}
                disabled={signOff.disabled}
                title={signOff.title}
                className="inline-flex items-center gap-2 rounded-lg bg-[#025945] px-4 py-2 text-sm font-medium text-white hover:bg-[#03674f] disabled:opacity-50"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {signOff.label}
              </button>
              <button onClick={reset} disabled={pending} className={ghost}>
                <RotateCcw className="h-3.5 w-3.5" />
                Rebuild from the order
              </button>
            </>
          )}
          <button onClick={download} disabled={downloading} className={`${ghost} ml-auto`}>
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="h-3.5 w-3.5" />
            )}
            {dirty ? 'Download last saved (PDF)' : 'Download PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RowGroup({
  title,
  hint,
  readOnly,
  onAdd,
  children,
}: {
  title: string
  hint: string
  readOnly: boolean
  onAdd: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-gray-100 px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500">{hint}</p>
        </div>
        {!readOnly && (
          // Never squeezed by a long hint beside it: the Materials hint grew a sentence about
          // colours on 23 Sep 2026 and folded the button onto two lines.
          <button onClick={onAdd} className={`${ghost} shrink-0 whitespace-nowrap`} type="button">
            <Plus className="h-3.5 w-3.5" />
            Add line
          </button>
        )}
      </div>
      <div className="mt-2.5 space-y-2">{children}</div>
    </div>
  )
}

function RemoveButton({
  readOnly,
  title,
  onClick,
}: {
  readOnly: boolean
  title: string
  onClick: () => void
}) {
  if (readOnly) return <span />
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs italic text-gray-400">{children}</p>
}
