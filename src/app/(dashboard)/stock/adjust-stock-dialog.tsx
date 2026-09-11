'use client'

// page-state: none (dialog-scoped; nothing worth restoring)

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { STOCK_WAREHOUSES } from '@/lib/stock/warehouses'
import type { ItemKind } from '@/lib/stock/movements'
import { recordStockAdjustmentAction } from './actions'

/**
 * A one-off manual adjustment with a mandatory reason. For a full recount use
 * Record count; this is for the broken pallet, the miscounted box. The ref id
 * is minted once per open, so a double click applies once.
 */
export function AdjustStockDialog({ itemKind, defaultWarehouse }: { itemKind: ItemKind; defaultWarehouse: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [warehouse, setWarehouse] = useState(defaultWarehouse)
  const [sku, setSku] = useState('')
  const [delta, setDelta] = useState('')
  const [note, setNote] = useState('')
  const [refId, setRefId] = useState('')
  const [pending, setPending] = useState(false)

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setRefId(crypto.randomUUID())
      setWarehouse(defaultWarehouse)
      setSku('')
      setDelta('')
      setNote('')
    }
  }

  const n = Number(delta)
  const valid = sku.trim() !== '' && delta.trim() !== '' && Number.isFinite(n) && n !== 0 && note.trim().length >= 5

  const submit = async () => {
    if (pending || !valid) return
    setPending(true)
    try {
      const res = await recordStockAdjustmentAction({ itemKind, warehouse, sku: sku.trim(), delta: n, note: note.trim(), refId })
      if (!res.success) {
        toast.error(res.error, { duration: 12000 })
        return
      }
      toast.success(res.data.applied > 0 ? `${sku.trim().toUpperCase()} adjusted by ${n > 0 ? '+' : ''}${n} at ${warehouse}.` : 'Already applied.', {
        duration: 8000,
      })
      setOpen(false)
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Adjust</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust a level</DialogTitle>
          <DialogDescription>
            A signed change to one {itemKind === 'finished' ? 'SKU' : 'component'}, with the reason. For a full recount use Record count instead.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-600">Warehouse</span>
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm">
              {STOCK_WAREHOUSES.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-600">{itemKind === 'finished' ? 'SKU' : 'Component code'}</span>
            <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder={itemKind === 'finished' ? 'EBH9NA' : 'PC350FR-UV21'} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 font-mono text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-600">Change (negative to deduct)</span>
            <input value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="decimal" placeholder="-2" className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm tabular-nums" />
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-600">Why (required)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Two panels damaged on unloading" className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending || !valid}>
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Apply adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
