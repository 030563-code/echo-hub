'use client'

// page-state: none (one render of a failure, plus a reload marker in
// sessionStorage that exists only to stop a reload loop.)

import Link from 'next/link'
import { useEffect } from 'react'

/**
 * What the Hub shows when something throws, and how it gets you out.
 *
 * Until 16 Sep 2026 there was no error boundary anywhere in the app, so every
 * unhandled error landed on Next's built-in "This page couldn't load. Reload to
 * try again, or go back." That page names nothing, fixes nothing, and is where
 * Dean landed pressing Sign Out.
 *
 * ONE CASE SELF-HEALS. A tab opened before a deploy holds Server Action ids the
 * new build does not have, and the first button pressed throws "Server Action
 * ... was not found on the server". The page is simply out of date, and a reload
 * fetches the current build, so this reloads once rather than asking somebody to
 * understand that. Guarded by a timestamp in sessionStorage: if the reload did
 * not help, the second failure inside thirty seconds shows the card instead of
 * looping.
 */

/** Next throws this, client-side, when the running build has no such action. */
const STALE_BUILD = /Server Action .*was not found on the server|Failed to find Server Action/i

const RELOAD_MARK = 'eb-hub-stale-reload-at'
const RELOAD_WINDOW_MS = 30_000

export function ErrorRecovery({
  error,
  reset,
  /** global-error renders outside the root layout, so it cannot use Tailwind. */
  plain = false,
}: {
  error: Error & { digest?: string }
  reset?: () => void
  plain?: boolean
}) {
  const stale = STALE_BUILD.test(String(error?.message ?? ''))

  useEffect(() => {
    if (!stale) return
    let last = 0
    try {
      last = Number(sessionStorage.getItem(RELOAD_MARK) ?? 0)
    } catch {
      // Private mode, or storage refused. Fall through and reload once; the
      // worst case is the card appearing after a second failure.
    }
    if (Date.now() - last < RELOAD_WINDOW_MS) return

    try {
      sessionStorage.setItem(RELOAD_MARK, String(Date.now()))
    } catch {
      /* not worth failing the recovery over */
    }
    // No state is set here on purpose: this render is about to be thrown away
    // by the reload, and setting state inside an effect only buys a frame
    // nobody sees while costing a cascading render.
    window.location.reload()
  }, [stale])

  const title = stale ? 'The Hub was updated' : 'Something went wrong'

  const body = stale
    ? 'This page was loaded before the last update, so that button no longer exists. Fetching the current version now; press Reload if nothing happens.'
    : 'That page could not be shown. Nothing you were doing has been lost; reloading usually fixes it.'

  if (plain) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui, sans-serif', background: '#f9fafb' }}>
        <div style={{ maxWidth: 420, width: '100%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#111827' }}>{title}</h1>
          <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, color: '#4b5563' }}>{body}</p>
          {error?.digest && (
            <p style={{ marginTop: 8, fontSize: 12, color: '#9ca3af' }}>Reference {error.digest}</p>
          )}
          <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => window.location.reload()} style={{ padding: '8px 18px', borderRadius: 8, border: 0, background: '#FF7026', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
              Reload
            </button>
            <a href="/login" style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', color: '#374151', fontSize: 14, textDecoration: 'none' }}>
              Sign in again
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          {title}
        </h1>
        <p className="mt-2 text-sm text-gray-600">{body}</p>
        {error?.digest && <p className="mt-2 text-xs text-gray-400">Reference {error.digest}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-echo-orange px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-echo-orange-hover"
          >
            Reload
          </button>
          {reset && !stale && (
            <button
              onClick={reset}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              Try again
            </button>
          )}
          <Link
            href="/"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}
