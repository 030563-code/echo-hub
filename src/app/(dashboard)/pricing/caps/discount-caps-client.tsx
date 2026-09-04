'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { saveDiscountCap } from '@/app/actions/pricing/save-pricing'
import { formatMoney } from '@/lib/utils'
import type { DiscountCapRecord } from '@/app/actions/pricing/get-pricing'
import { EditRowDialog } from '../edit-row-dialog'

interface Rep {
  id: string
  display_name: string | null
  email: string | null
  pipelineLabel: string
}

/**
 * The cap as a column, or null when there is none.
 *
 * Deliberately not describeCap(): that builds a sentence addressed to the rep
 * whose cap it is ("Your limit: ..."), and stripping the prefix here would
 * break the moment its wording changed.
 */
function limitText(cap: DiscountCapRecord | undefined): string | null {
  if (!cap) return null
  const parts: string[] = []
  if (cap.max_discount_pct != null) parts.push(`${Number(cap.max_discount_pct)}%`)
  if (cap.max_discount_per_unit != null) parts.push(`${formatMoney(Number(cap.max_discount_per_unit), 'USD')} per unit`)
  return parts.length > 0 ? parts.join(' or ') : null
}

function num(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function CapEditor({ rep, cap }: { rep: Rep; cap: DiscountCapRecord | undefined }) {
  const router = useRouter()
  const [pct, setPct] = useState(cap?.max_discount_pct == null ? '' : String(cap.max_discount_pct))
  const [perUnit, setPerUnit] = useState(cap?.max_discount_per_unit == null ? '' : String(cap.max_discount_per_unit))

  return (
    <EditRowDialog
      title={`Discount cap for ${rep.display_name ?? rep.email ?? 'this rep'}`}
      trigger={<Button size="sm" variant="outline">{cap ? 'Edit' : 'Set a cap'}</Button>}
      onSave={async () => {
        const p = num(pct)
        const u = num(perUnit)
        if (p !== null && (p < 0 || p > 100)) return { success: false as const, error: 'A percentage has to be between 0 and 100.' }
        if (u !== null && u < 0) return { success: false as const, error: 'A per-unit limit cannot be negative.' }
        return saveDiscountCap({ user_id: rep.id, max_discount_pct: p, max_discount_per_unit: u })
      }}
      onSaved={() => router.refresh()}
    >
      <div>
        <Label htmlFor="pct" className="text-gray-900">Maximum discount percentage</Label>
        <Input id="pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} className="mt-1" placeholder="Blank for no percentage limit" />
      </div>
      <div>
        <Label htmlFor="perUnit" className="text-gray-900">Maximum discount per unit</Label>
        <Input id="perUnit" inputMode="decimal" value={perUnit} onChange={(e) => setPerUnit(e.target.value)} className="mt-1" placeholder="Blank for no cash limit" />
      </div>
      <p className="text-xs text-gray-500">
        Leave both blank and this rep cannot discount at all. Both limits are checked against the
        discount however the rep types it, so a cash entry cannot get around a percentage cap.
      </p>
    </EditRowDialog>
  )
}

export function DiscountCapsClient({
  reps,
  caps,
  scopedToRegion,
}: {
  reps: Rep[]
  caps: DiscountCapRecord[]
  /** True when the list was narrowed to the viewer's own region. A super admin
   *  sees everyone, so an empty list means something else entirely. */
  scopedToRegion: boolean
}) {
  const capByUser = new Map(caps.map((c) => [c.user_id, c]))

  // The old copy asserted one cause, "your profile has no region set", whatever
  // the reason. That was wrong for a super admin, who is never scoped, and it
  // sent Dean looking at his own profile when the real fault was a query
  // selecting a profiles.email column that does not exist. Say only what is
  // actually known.
  if (reps.length === 0) {
    return (
      <Card className="bg-white border-gray-200 p-4">
        <p className="text-sm text-gray-600">
          {scopedToRegion
            ? 'No reps to show. Your profile has no region set, so nobody is scoped to you. Ask an admin to set your region.'
            : 'No reps to show. There are no user profiles to cap, which is unexpected on a working Hub, so check the server log for the reason.'}
        </p>
      </Card>
    )
  }

  return (
    <Card className="bg-white border-gray-200 p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-600">
              <th className="px-4 py-3 font-medium">Rep</th>
              <th className="px-4 py-3 font-medium">Region</th>
              <th className="px-4 py-3 font-medium">Current limit</th>
              <th className="px-4 py-3 font-medium">Last changed by</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {reps.map((rep) => {
              const cap = capByUser.get(rep.id)
              return (
                <tr key={rep.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-gray-900">{rep.display_name ?? 'Unnamed'}</span>
                    <span className="block text-xs text-gray-400">{rep.email}</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{rep.pipelineLabel}</td>
                  <td className={`px-4 py-2.5 ${limitText(cap) ? 'text-gray-900' : 'text-gray-500'}`}>
                    {limitText(cap) ?? 'No discount allowed'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">{cap?.updated_by_label ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <CapEditor rep={rep} cap={cap} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
