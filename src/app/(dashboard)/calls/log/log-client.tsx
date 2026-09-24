'use client'

// page-state: view calls:log (which filter and search box the rep left it on)

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { hubspotRecordUrl } from '@/lib/hubspot-links'
import { Button } from '@/components/ui/button'
import { SearchBox } from '@/components/ui/search-box'
import StatusBadge from "@/components/board/StatusBadge"
import { usePersistedView } from '@/hooks/use-page-state'
import { useViewerTimeZone } from '@/hooks/use-viewer-time-zone'
import { parseCallsView, type CallsView } from '@/lib/page-drafts'
import { MISSED_REASONS } from '@/lib/calls/missed-reasons'
import { LINK_REASON_LABELS } from '@/lib/calls/link-state'
import { callDate, callTime, callWhen } from '@/lib/calls/call-time'
import type { CallListItem } from '@/lib/calls/board-data'
import { recordMissedReason, setCallLinkState } from '../actions'
import { LinkContactDialog } from '../link-contact-dialog'

const FILTERS = [
  { key: 'needs_link', label: 'Needs linking' },
  { key: 'all', label: 'All calls' },
  { key: 'linked', label: 'Linked' },
] as const

function duration(seconds: number | null): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** A withheld caller arrives as the literal string 'anonymous'. Never show that. */
function caller(call: CallListItem): string {
  return call.caller_phone_e164 ?? 'Withheld'
}

export function CallLogClient({ calls, canSeeNothing }: { calls: CallListItem[]; canSeeNothing: boolean }) {
  const [view, setView] = usePersistedView<CallsView>('calls:log', { v: 1, filter: 'needs_link', q: '' }, parseCallsView)
  const [openCall, setOpenCall] = useState<string | null>(null)
  const [linking, setLinking] = useState<CallListItem | null>(null)
  const timeZone = useViewerTimeZone()

  const shown = useMemo(() => {
    const needle = view.q.trim().toLowerCase()
    return calls
      .filter((c) =>
        view.filter === 'all' ? true : view.filter === 'linked' ? c.link_state === 'linked' : c.link_state === 'needs_link',
      )
      .filter((c) =>
        needle === ''
          ? true
          : `${c.caller_phone ?? ''} ${c.contactName ?? ''} ${c.contact_email ?? ''} ${c.summary ?? ''} ${c.office}`
              .toLowerCase()
              .includes(needle),
      )
  }, [calls, view])

  if (canSeeNothing) {
    return (
      <Card className="border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-700">
          No region is set on your profile, so there are no calls to show you yet. Ask Dean to set your
          sales region and this fills in.
        </p>
      </Card>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setView({ ...view, filter: f.key })}
              className={
                view.filter === f.key
                  ? 'rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white'
                  : 'rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-300'
              }
            >
              {f.label}
              {f.key === 'needs_link' && (
                <span className="ml-1.5 text-[10px] opacity-80">
                  {calls.filter((c) => c.link_state === 'needs_link').length}
                </span>
              )}
            </button>
          ))}
        </div>
        <SearchBox value={view.q} onChange={(q) => setView({ ...view, q })} placeholder="Number, name, summary…" />
      </div>

      {shown.length === 0 ? (
        <Card className="border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">
            {calls.length === 0
              ? 'No calls yet. They appear here as the phone system takes them.'
              : 'Nothing matches that filter.'}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden border-gray-200 bg-white p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-2.5 text-left font-medium">When</th>
                  <th className="px-3 py-2.5 text-left font-medium">Office</th>
                  <th className="px-3 py-2.5 text-left font-medium">From</th>
                  <th className="px-3 py-2.5 text-left font-medium">Contact</th>
                  <th className="px-3 py-2.5 text-left font-medium">What was discussed</th>
                  <th className="px-3 py-2.5 text-left font-medium">Type</th>
                  <th className="px-3 py-2.5 text-right font-medium">Length</th>
                  <th className="px-3 py-2.5 text-left font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((call) => (
                  <CallRow
                    key={call.id}
                    call={call}
                    timeZone={timeZone}
                    open={openCall === call.id}
                    onToggle={() => setOpenCall(openCall === call.id ? null : call.id)}
                    onLink={() => setLinking(call)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <LinkContactDialog
        key={linking?.id ?? 'closed'}
        open={linking !== null}
        onClose={() => setLinking(null)}
        callId={linking?.id}
        subject={linking ? `${caller(linking)}, ${linking.office}, ${callWhen(linking.call_at, timeZone)}` : ''}
      />
    </div>
  )
}

function CallRow({
  call,
  timeZone,
  open,
  onToggle,
  onLink,
}: {
  call: CallListItem
  /** The reader's zone, null until the page has hydrated. */
  timeZone: string | null
  open: boolean
  onToggle: () => void
  onLink: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [reason, setReason] = useState(call.missed_reason ?? '')
  const [note, setNote] = useState(call.missed_note ?? '')

  const needsReason = call.missed && !call.missed_reason
  const canLink = call.link_state === 'needs_link' && !needsReason

  const saveReason = () =>
    start(async () => {
      const result = await recordMissedReason({ callId: call.id, reason, note })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Reason saved')
      router.refresh()
    })

  const ignore = () =>
    start(async () => {
      const result = await setCallLinkState({ callId: call.id, state: 'ignored' })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })

  return (
    <>
      <tr
        className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${open ? 'bg-gray-50' : ''}`}
        onClick={onToggle}
      >
        <td className="px-4 py-2.5 whitespace-nowrap">
          <time dateTime={call.call_at}>
            <span className="block text-gray-900">{callDate(call.call_at, timeZone)}</span>
            <span className="block text-xs tabular-nums text-gray-500">{callTime(call.call_at, timeZone)}</span>
          </time>
        </td>
        <td className="px-3 py-2.5 text-gray-700">{call.office}</td>
        <td className="px-3 py-2.5 font-mono text-xs text-gray-700">{caller(call)}</td>
        <td className="px-3 py-2.5">
          <span className="block text-gray-900">{call.contactName ?? '—'}</span>
          <span className="block text-xs text-gray-500">{call.contact_email ?? 'no email'}</span>
        </td>
        <td className="px-3 py-2.5">
          {/* The gist on the row, the whole thing in the panel. A department
              notification carries no recording, so there is nothing to
              summarise and saying so beats an empty cell. */}
          {call.summary ? (
            <span className="block max-w-sm truncate text-gray-700" title={call.summary}>
              {call.summary}
            </span>
          ) : (
            <span className="text-xs text-gray-400">
              {call.call_type === 'department_notification' ? 'Not recorded' : 'No summary'}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5">
          <StatusBadge status={call.call_type} />
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{duration(call.duration_seconds)}</td>
        <td className="px-3 py-2.5">
          {call.link_state === 'needs_link' && <StatusBadge status="needs_link" />}
          {call.link_state === 'linked' && <StatusBadge status="linked" />}
          {call.link_state === 'no_contact' && <StatusBadge status="no_contact" />}
          {call.link_state === 'ignored' && <StatusBadge status="ignored" />}
        </td>
      </tr>

      {open && (
        <tr className="border-t border-gray-100 bg-gray-50/60">
          <td colSpan={8} className="px-4 py-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                {call.reasons.length > 0 && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-medium text-amber-900">Why this one needs you</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-900">
                      {call.reasons.map((r) => (
                        <li key={r}>{LINK_REASON_LABELS[r]}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {call.summary && (
                  <div>
                    <p className="text-xs font-medium text-gray-500">Summary</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{call.summary}</p>
                  </div>
                )}

                {call.missed && (
                  <div className="rounded border border-gray-200 bg-white p-3">
                    <p className="text-xs font-medium text-gray-700">
                      Nobody took this call. Say why before linking it.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800"
                      >
                        <option value="">Pick a reason…</option>
                        {MISSED_REASONS.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Note (optional)"
                        maxLength={500}
                        className="min-w-[12rem] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                      />
                      <Button variant="outline" onClick={saveReason} disabled={!reason || pending}>
                        {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Save reason
                      </Button>
                    </div>
                    {call.missed_reason && (
                      <p className="mt-2 text-xs text-gray-500">
                        Recorded{call.missed_reason_at ? ` ${callWhen(call.missed_reason_at, timeZone)}` : ''}.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {(call.transcript_english || call.transcript) && (
                  <div>
                    <p className="text-xs font-medium text-gray-500">
                      {call.transcript_english && call.language && call.language !== 'en'
                        ? 'Transcript (English)'
                        : 'Transcript'}
                    </p>
                    {/* Rendered as text on purpose. This is model output that
                        reached us over an unsigned webhook, so it is never
                        injected as markup. */}
                    <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-xs text-gray-700">
                      {call.transcript_english || call.transcript}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {canLink && <Button onClick={onLink}>Link to a contact</Button>}
                  {needsReason && <span className="text-xs text-amber-800">Give a reason first</span>}
                  {call.link_state === 'needs_link' && (
                    <Button variant="outline" onClick={ignore} disabled={pending}>
                      Not worth linking
                    </Button>
                  )}
                  {call.hubspot_contact_id && (
                    <a
                      href={hubspotRecordUrl("contact", call.hubspot_contact_id) ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-echo-orange hover:underline"
                    >
                      Open the contact in HubSpot
                    </a>
                  )}
                </div>

                <p className="text-[11px] text-gray-400">
                  Transcribed and summarised automatically. Check it before acting on it.
                  {call.recording_url ? ' The recording needs Twilio credentials to play.' : ''}
                </p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
