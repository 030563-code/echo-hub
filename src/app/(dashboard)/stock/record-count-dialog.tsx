'use client'

// page-state: none (dialog-scoped; committed on confirm, nothing worth restoring)

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ConfirmPanel } from '@/components/ui/confirm-panel'
import { parseCountInput } from '@/lib/stock/count-parse'
import { STOCK_WAREHOUSES } from '@/lib/stock/warehouses'
import type { ItemKind } from '@/lib/stock/movements'
import { recordStockCountAction } from './actions'

/**
 * Record a physical count. Paste `sku,qty` lines (or pick a CSV), see the
 * parse, confirm. The batch id is minted once per open, so a double click or
 * a retry after a timeout cannot count twice.
 */
export function RecordCountDialog({ itemKind, defaultWarehouse }: { itemKind: ItemKind; defaultWarehouse: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [warehouse, setWarehouse] = useState(defaultWarehouse)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [batchId, setBatchId] = useState<string>('')
  const [pending, setPending] = useState(false)

  const parsed = useMemo(() => parseCountInput(text), [text])
  const label = itemKind === 'finished' ? 'SKU' : 'component code'

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setBatchId(crypto.randomUUID())
      setWarehouse(defaultWarehouse)
      setText('')
      setNote('')
    }
  }

  const onFile = (file: File | null) => {
    if (!file) return
    file.text().then(setText)
  }

  const submit = async () => {
    if (pending || parsed.rows.length === 0 || parsed.errors.length > 0) return
    setPending(true)
    try {
      const res = await recordStockCountAction({ itemKind, warehouse, batchId, note, rows: parsed.rows })
      if (!res.success) {
        toast.error(res.error, { duration: 12000 })
        return
      }
      const changed = res.data.filter((r) => r.applied).length
      toast.success(
        `Count recorded for ${res.data.length} ${label}${res.data.length === 1 ? '' : 's'} at ${warehouse}. ${changed} level${changed === 1 ? '' : 's'} changed.`,
        { duration: 8000 },
      )
      setOpen(false)
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Record count</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a physical count</DialogTitle>
          <DialogDescription>
            One line per {label}: <span className="font-mono">{itemKind === 'finished' ? 'EBH9NA,25' : 'PC350FR-UV21,142.5'}</span>.
            Commas, semicolons or tabs. A header row is fine. The level becomes what was counted.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-600">Warehouse</span>
            <select
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm"
            >
              {STOCK_WAREHOUSES.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-600">Note (who counted, when)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="Physical count by Juraj, 12 Sep"
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm"
            />
          </label>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={itemKind === 'finished' ? 'EBH9NA,25\nEBH10NA,40' : 'PC350FR-UV21,142.5\nACI-T40,400'}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm"
        />
        <label className="text-xs text-gray-500">
          or choose a CSV file:{' '}
          <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        </label>

        {parsed.errors.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            <p className="font-medium">Fix these before recording:</p>
            <ul className="mt-1 space-y-0.5">
              {parsed.errors.slice(0, 12).map((e) => (
                <li key={`${e.line}-${e.message}`}>line {e.line}: {e.message}</li>
              ))}
              {parsed.errors.length > 12 && <li>and {parsed.errors.length - 12} more</li>}
            </ul>
          </div>
        )}

        {parsed.rows.length > 0 && parsed.errors.length === 0 && (
          <ConfirmPanel>
            {parsed.rows.length} {label}{parsed.rows.length === 1 ? '' : 's'} at <span className="font-mono">{warehouse}</span> will be set to the counted figure.
            Each change is written as a count movement; the count date is stamped either way.
          </ConfirmPanel>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending || parsed.rows.length === 0 || parsed.errors.length > 0}>
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Record count
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
