'use client'

/**
 * "You were in the middle of this."
 *
 * Restoring someone's typing silently is worse than losing it: they cannot tell
 * whether what is on screen is theirs, this deal's, or left over from a
 * colleague. So every page that restores a DRAFT says so, in one line, with the
 * way out right next to it.
 *
 * Deliberately not a toast. A toast is gone in four seconds and this fact
 * matters for as long as the draft is on screen.
 */

import { RotateCcw, Check, AlertTriangle } from 'lucide-react'
import type { SaveStatus } from '@/hooks/use-page-state'

function savedTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function DraftStrip({
  savedAt,
  stale = false,
  staleNote,
  onStartAgain,
  startAgainLabel = 'Start again',
  saveStatus = 'idle',
  what = 'where you left off',
  dark = false,
}: {
  /** When the draft on screen was saved. */
  savedAt: string | null
  /** The record underneath moved on since this was saved. */
  stale?: boolean
  /** What that means here, in the page's own words. */
  staleNote?: string
  onStartAgain: () => void
  startAgainLabel?: string
  saveStatus?: SaveStatus
  /** Completes "Picked up ...". */
  what?: string
  /** The operations screens are dark; a light strip on them reads as a bug. */
  dark?: boolean
}) {
  const when = savedTime(savedAt)
  const shell = stale
    ? dark
      ? 'border-amber-700/50 bg-amber-900/20'
      : 'border-amber-300 bg-amber-50'
    : dark
      ? 'border-[#2a2a2a] bg-[#1a1a1a]'
      : 'border-gray-200 bg-gray-50'
  const bodyText = dark ? 'text-[#9ca3af]' : 'text-gray-700'
  const strongText = dark ? 'text-white' : 'text-gray-900'
  const linkText = dark
    ? 'text-[#e5e5e5] hover:text-white'
    : 'text-gray-900 hover:text-black'
  const mutedText = dark ? 'text-[#6b7280]' : 'text-gray-500'

  return (
    <div className={`rounded-md border px-4 py-2.5 ${shell}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className={`text-sm ${bodyText}`}>
          <span className={`font-medium ${strongText}`}>Picked up {what}</span>
          {when ? `, saved ${when}` : ''}.
        </p>

        <button
          type="button"
          onClick={onStartAgain}
          className={`inline-flex items-center gap-1.5 min-h-11 sm:min-h-0 text-sm font-medium underline underline-offset-2 ${linkText}`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {startAgainLabel}
        </button>

        <span className={`ml-auto text-xs ${mutedText}`} aria-live="polite">
          {saveStatus === 'saving' ? (
            'Saving…'
          ) : saveStatus === 'saved' ? (
            <span className={`inline-flex items-center gap-1 ${mutedText}`}>
              <Check className="h-3 w-3" />
              Saved
            </span>
          ) : saveStatus === 'error' ? (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              Not saved, your work is still on screen
            </span>
          ) : null}
        </span>
      </div>

      {stale && staleNote && (
        <p className={`mt-1 text-xs ${dark ? 'text-amber-300' : 'text-amber-800'}`}>{staleNote}</p>
      )}
    </div>
  )
}

/**
 * The same save indicator without the restore line, for a page that is saving
 * as you type but did not restore anything this time.
 */
export function SaveHint({ saveStatus }: { saveStatus: SaveStatus }) {
  if (saveStatus !== 'saving' && saveStatus !== 'saved' && saveStatus !== 'error') return null
  return (
    <p className="text-xs text-gray-500" aria-live="polite">
      {saveStatus === 'saving'
        ? 'Saving…'
        : saveStatus === 'saved'
          ? 'Saved, so you can leave this page and come back'
          : 'Could not save your progress, your work is still on screen'}
    </p>
  )
}
