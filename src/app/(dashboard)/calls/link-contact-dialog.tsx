'use client'

// page-state: none (dialog-scoped, committed on save; a half-typed contact
// search is not worth restoring, and the merge behind it is irreversible)

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmPanel } from '@/components/ui/confirm-panel'
import {
  findContactsForCall,
  linkCallToContact,
  linkPlaceholderToContact,
  type ContactHit,
} from './actions'

/**
 * Find the contact the rep created, and merge the placeholder into it.
 *
 * Email first, because that is the field the two records have in common: the
 * placeholder has a phone and no email, the rep's contact has an email and no
 * phone.
 *
 * The merge is irreversible, so nothing here happens on a single click. The rep
 * searches, picks, reads what will change in plain words, and then confirms. If
 * the placeholder carries more than this one call, or any deal, the action
 * refuses the first time and says how much moves, and the rep has to agree to
 * that specifically.
 */
/** HubSpot search on one or two characters is noise, not a search. */
const TYPE_AT_LEAST = 3

export function LinkContactDialog({
  open,
  onClose,
  /** Linking from a call in the Hub's own log. */
  callId,
  /** Linking from the placeholder list, where there may be no call at all. */
  placeholderId,
  subject,
}: {
  open: boolean
  onClose: () => void
  callId?: string
  placeholderId?: string
  /** What is being linked, in words: the number and where it called. */
  subject: string
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ContactHit[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<ContactHit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [extra, setExtra] = useState<{ calls: number; deals: number } | null>(null)
  const [pending, start] = useTransition()
  const seq = useRef(0)

  // Debounced, with a sequence guard so a slow early response cannot overwrite a
  // fast later one. Every setState happens inside the timer, never in the effect
  // body: the React Compiler lint refuses the latter, and it is right, because a
  // synchronous set here re-renders on every keystroke before the search runs.
  useEffect(() => {
    const term = query.trim()
    if (term.length < TYPE_AT_LEAST) return
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      if (mine !== seq.current) return
      setSearching(true)
      const result = await findContactsForCall({ query: term })
      if (mine !== seq.current) return
      setSearching(false)
      if (!result.success) {
        setError(result.error)
        setHits([])
        return
      }
      setError(null)
      setHits(result.data)
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Derived, not stored: below three characters there is nothing to show, and
  // computing that is cheaper and safer than clearing state in an effect.
  const ready = query.trim().length >= TYPE_AT_LEAST
  const visible = ready ? hits : []

  if (!open) return null

  const confirm = (confirmExtra: boolean) => {
    if (!picked?.email) return
    setError(null)
    start(async () => {
      const result = placeholderId
        ? await linkPlaceholderToContact({
            placeholderId,
            contactId: picked.id,
            contactEmail: picked.email,
            confirmExtra,
          })
        : await linkCallToContact({
            callId: callId as string,
            contactId: picked.id,
            contactEmail: picked.email as string,
            confirmExtra,
          })

      if (!result.success) {
        setError(result.error)
        if (result.needsConfirmation) setExtra(result.needsConfirmation)
        return
      }
      toast.success(`Merged into ${picked.email}`)
      onClose()
      router.refresh()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-16" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Link to the right contact</h2>
            <p className="mt-0.5 text-xs text-gray-500">{subject}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label htmlFor="contact-search" className="text-sm font-medium text-gray-700">
            Search by email address
          </label>
          <div className="relative mt-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              id="contact-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPicked(null)
                setExtra(null)
              }}
              placeholder="name@company.com, or a name"
              autoFocus
              className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-echo-orange focus:outline-none"
            />
          </div>

          {searching && <p className="mt-2 text-xs text-gray-500">Searching HubSpot…</p>}

          {!searching && ready && visible.length === 0 && !error && (
            <p className="mt-3 text-sm text-gray-500">
              No contact matches that. Create the contact in HubSpot first, then come back.
            </p>
          )}

          {visible.length > 0 && !picked && (
            <ul className="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
              {visible.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    disabled={hit.isPlaceholder || !hit.email}
                    onClick={() => setPicked(hit)}
                    className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-900">{hit.name}</span>
                      <span className="block truncate text-xs text-gray-500">
                        {hit.email ?? 'no email'}
                        {hit.company ? ` · ${hit.company}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-gray-400">
                      {hit.isPlaceholder ? 'placeholder' : hit.phone ? hit.phone : 'no phone'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {picked && (
            <div className="mt-4 space-y-3">
              <ConfirmPanel>
                <p className="font-medium text-gray-900">
                  {picked.name} ({picked.email})
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>keeps its name, email and owner, and gains the caller&apos;s phone number</li>
                  <li>gains this call, and anything else attached to the placeholder</li>
                  <li>
                    the <span className="font-medium">Unknown Caller</span> record is merged away and
                    stops appearing in HubSpot
                  </li>
                  {picked.phone && (
                    <li>
                      it already has {picked.phone}, which HubSpot keeps: the merge only fills what is
                      blank
                    </li>
                  )}
                </ul>
                <p className="mt-2 text-xs text-gray-600">HubSpot cannot undo a merge.</p>
              </ConfirmPanel>

              {extra && (
                <ConfirmPanel className="border-red-300 bg-red-50">
                  This number carries {extra.calls} calls and {extra.deals} deals. All of them move onto{' '}
                  {picked.email}. Only go ahead if they are the same person.
                </ConfirmPanel>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" onClick={() => setPicked(null)} disabled={pending}>
                  Pick someone else
                </Button>
                <Button onClick={() => confirm(extra !== null)} disabled={pending}>
                  {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {extra ? `Merge all ${extra.calls} calls` : 'Merge them'}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  )
}
