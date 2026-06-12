'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2, CalendarCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { addWeeklyItem, setWeeklyItemStatus, deleteWeeklyItem } from './actions'

export interface WeeklyItem {
  id: string
  week_start_date: string
  day: 'mon' | 'tue' | 'wed'
  title: string
  owner: string | null
  status: 'todo' | 'doing' | 'done'
  notes: string | null
  created_at: string
}

type Day = 'mon' | 'tue' | 'wed'
const DAYS: { key: Day; label: string }[] = [
  { key: 'mon', label: 'Mondays' },
  { key: 'tue', label: 'Tuesdays' },
  { key: 'wed', label: 'Wednesdays' },
]

const STATUS_STYLES: Record<WeeklyItem['status'], string> = {
  todo: 'bg-gray-100 text-gray-600 border-gray-200',
  doing: 'bg-amber-100 text-amber-700 border-amber-200',
  done: 'bg-emerald-100 text-emerald-700 border-emerald-200',
}
const NEXT_STATUS: Record<WeeklyItem['status'], WeeklyItem['status']> = {
  todo: 'doing',
  doing: 'done',
  done: 'todo',
}

interface Props {
  weekStart: string
  items: WeeklyItem[]
  canEdit: boolean
  notProvisioned: boolean
}

export default function WeekliesClient({ weekStart, items, canEdit, notProvisioned }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [drafts, setDrafts] = useState<Record<Day, { title: string; owner: string }>>({
    mon: { title: '', owner: '' },
    tue: { title: '', owner: '' },
    wed: { title: '', owner: '' },
  })

  const run = (fn: () => Promise<{ success: true } | { error: string }>, onOk?: () => void) =>
    startTransition(async () => {
      const res = await fn()
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      onOk?.()
      router.refresh()
    })

  const add = (day: Day) => {
    const draft = drafts[day]
    if (!draft.title.trim()) return
    run(
      () => addWeeklyItem({ week_start_date: weekStart, day, title: draft.title, owner: draft.owner || undefined }),
      () => setDrafts((d) => ({ ...d, [day]: { title: '', owner: '' } }))
    )
  }

  const prettyWeek = new Date(weekStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <CalendarCheck className="w-7 h-7 text-echo-orange" />
        <h1 className="text-2xl font-bold text-gray-900">Weeklies</h1>
      </div>
      <p className="text-gray-600 mb-6">Operating cadence — week of {prettyWeek}.</p>

      {notProvisioned && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The tracker table isn’t provisioned yet — apply the <code>weekly_items</code> migration to enable saving.
          The board is shown empty until then.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {DAYS.map(({ key, label }) => {
          const dayItems = items.filter((i) => i.day === key)
          return (
            <div key={key} className="rounded-lg border border-gray-200 bg-white flex flex-col">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-bold text-gray-900">{label}</h2>
                <span className="text-xs text-gray-400">{dayItems.length}</span>
              </div>

              <div className="p-3 space-y-2 flex-1 min-h-[80px]">
                {dayItems.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">No items yet.</p>
                ) : (
                  dayItems.map((item) => (
                    <div key={item.id} className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-gray-900 leading-snug">{item.title}</p>
                        {canEdit && (
                          <button
                            onClick={() => run(() => deleteWeeklyItem(item.id))}
                            disabled={pending}
                            className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                            aria-label="Delete item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center justify-between mt-2">
                        {item.owner ? (
                          <span className="text-xs text-gray-500">{item.owner}</span>
                        ) : (
                          <span className="text-xs text-gray-300">Unassigned</span>
                        )}
                        <button
                          onClick={() => canEdit && run(() => setWeeklyItemStatus(item.id, NEXT_STATUS[item.status]))}
                          disabled={!canEdit || pending}
                          className={`text-[11px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_STYLES[item.status]} ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                          title={canEdit ? 'Click to advance status' : undefined}
                        >
                          {item.status}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {canEdit && (
                <div className="p-3 border-t border-gray-100 space-y-2">
                  <Input
                    placeholder="Add an item…"
                    value={drafts[key].title}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: { ...d[key], title: e.target.value } }))}
                    onKeyDown={(e) => e.key === 'Enter' && add(key)}
                  />
                  <div className="flex gap-2">
                    <Input
                      placeholder="Owner (optional)"
                      value={drafts[key].owner}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: { ...d[key], owner: e.target.value } }))}
                      onKeyDown={(e) => e.key === 'Enter' && add(key)}
                    />
                    <Button onClick={() => add(key)} disabled={pending || !drafts[key].title.trim()} size="icon" variant="primary">
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
