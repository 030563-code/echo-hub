'use client'

/**
 * Remember where someone was on a page, and put them back there.
 *
 * Two hooks, because there are two kinds of state and they want opposite
 * treatment:
 *
 *  usePageState     a DRAFT: typed content (a cart, a wizard, a price sheet).
 *                   The page waits for the load before rendering its form, so
 *                   a restore can never land on top of something already being
 *                   typed, and it says out loud that it restored something.
 *  usePersistedView a VIEW: a filter, a search box, a tab, a sort. The page
 *                   renders immediately with its defaults and the saved value
 *                   is applied when it arrives, but only if the user has not
 *                   already touched the control. Silent, because nobody wants a
 *                   banner about a search box.
 *
 * Why the load happens HERE and not in the page's server component: Next's
 * client router cache reuses a page segment on browser Back regardless of
 * staleness ("Pages are not cached by default but are reused during browser
 * back/forward navigation"). A draft passed down as a server prop would come
 * back as whatever it was when the segment was first rendered, so going to
 * Pricing and pressing Back would restore an empty cart over a full one. Read
 * on mount in the browser and that whole class of bug does not exist.
 *
 * Why the restore arrives as a CALLBACK rather than as state the caller copies
 * in an effect: copying it in an effect means setState in an effect body, which
 * cascades renders and which this codebase already refuses elsewhere
 * (change-stage-dialog.tsx). The callback fires from inside the load, which is
 * exactly the "subscribe to an external system and setState in the callback"
 * shape effects are for.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { clearPageState, loadPageState, savePageState } from '@/app/actions/page-state'
import { isStale } from '@/lib/page-state'

/** Long enough that typing a line does not write on every keystroke, short
 *  enough that leaving the page a moment later still catches it. */
const DEBOUNCE_MS = 700

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface RestoredState<T> {
  data: T
  savedAt: string
  /** The record underneath this draft changed since it was saved. The consumer
   *  decides what that means: the quote builder flags it and restores anyway
   *  (the cart is the rep's own work), the invoice editor refuses. */
  stale: boolean
}

export interface UsePageStateOptions<T> {
  pageKey: string
  /** Turns whatever was stored into this page's shape, or null if it cannot.
   *  Stored state is data, never trusted structure: an older version of the app
   *  may have written it. A null here means "no draft", never a crash. */
  parse: (raw: unknown) => T | null
  /** Called exactly once per page key, when the read finishes: with the draft
   *  if there was a usable one, with null if there was not. This is where the
   *  page puts the values back into its own state. */
  onRestore?: (restored: RestoredState<T> | null) => void
  /** Fingerprint of the record this draft sits on, when there is one. */
  base?: string | null
  /** False stops all writing and cancels anything pending. Used the moment a
   *  submit succeeds, so nothing can re-create the draft that was just used. */
  enabled?: boolean
  /** "Nothing worth keeping." An empty page never creates a row, and emptying a
   *  page deletes the row it had, so a resume prompt never points at nothing. */
  isEmpty?: (data: T) => boolean
}

export interface UsePageStateResult<T> {
  status: 'loading' | 'ready'
  restored: RestoredState<T> | null
  /** Debounced. Safe to call on every render from an effect: identical payloads
   *  are dropped without a round trip. */
  save: (data: T) => void
  /** Forget the draft. Cancels anything pending, so a queued write cannot
   *  bring it back. */
  clear: () => Promise<void>
  saveStatus: SaveStatus
  savedAt: string | null
}

/** One piece of state for the whole load, tagged with the key it belongs to, so
 *  `status` is DERIVED rather than set from inside an effect. */
interface Loaded<T> {
  key: string
  restored: RestoredState<T> | null
}

export function usePageState<T>({
  pageKey,
  parse,
  onRestore,
  base = null,
  enabled = true,
  isEmpty,
}: UsePageStateOptions<T>): UsePageStateResult<T> {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  // A key change reads as "loading" immediately, with no render in between and
  // no setState in an effect to get there.
  const isLoaded = loaded !== null && loaded.key === pageKey
  const status: 'loading' | 'ready' = isLoaded ? 'ready' : 'loading'
  const restored = isLoaded ? loaded.restored : null

  // Values and callbacks whose identity changes every render, held in refs so
  // the returned `save` stays stable and can be called from an effect.
  const parseRef = useRef(parse)
  const onRestoreRef = useRef(onRestore)
  const isEmptyRef = useRef(isEmpty)
  const baseRef = useRef(base)
  const enabledRef = useRef(enabled)
  useEffect(() => {
    parseRef.current = parse
    onRestoreRef.current = onRestore
    isEmptyRef.current = isEmpty
    baseRef.current = base
    enabledRef.current = enabled
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The newest payload not yet written. */
  const pendingRef = useRef<string | null>(null)
  /** Serialises writes: two overlapping upserts could otherwise land out of
   *  order and persist the older cart. */
  const inFlightRef = useRef(false)
  /** What the server is known to hold, so an unchanged page writes nothing. */
  const lastJsonRef = useRef<string | null>(null)
  /** Whether a row exists at all, so emptying a page deletes rather than
   *  storing an empty one. */
  const hasStoredRef = useRef(false)
  const stoppedRef = useRef(false)
  const keyRef = useRef(pageKey)
  /** False until the row for the CURRENT key has been read. */
  const loadedRef = useRef(false)

  /** Write whatever is pending, then keep going if something newer arrived
   *  while that was in flight. A loop rather than recursion so the callback
   *  never has to reference itself. */
  const drain = useCallback(async () => {
    // Nothing may be WRITTEN before the read has finished, because until then
    // there is no way to know what is being overwritten. Saves that arrive
    // first are held in pendingRef and flushed by the load itself, so a page
    // typed into during a slow read still keeps what was typed. Dropping them
    // instead lost the last keystrokes whenever the read was slower than the
    // typing, which on a cold route it is.
    if (!loadedRef.current) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      while (pendingRef.current !== null && !stoppedRef.current && enabledRef.current) {
        const json = pendingRef.current
        pendingRef.current = null
        if (json === lastJsonRef.current) continue

        setSaveStatus('saving')
        const payload = JSON.parse(json) as T
        const empty = isEmptyRef.current?.(payload) === true

        try {
          if (empty) {
            // Nothing left on the page. Never store an empty row: it would
            // light up a resume prompt with nothing behind it.
            if (hasStoredRef.current) {
              await clearPageState(keyRef.current)
              hasStoredRef.current = false
            }
            lastJsonRef.current = json
            setSavedAt(null)
            setSaveStatus('idle')
          } else {
            const result = await savePageState(keyRef.current, payload, baseRef.current)
            if (result.ok) {
              lastJsonRef.current = json
              hasStoredRef.current = true
              setSavedAt(result.updatedAt)
              setSaveStatus('saved')
            } else {
              setSaveStatus('error')
            }
          }
        } catch {
          setSaveStatus('error')
        }
      }
    } finally {
      inFlightRef.current = false
    }
  }, [])

  const save = useCallback(
    (data: T) => {
      if (stoppedRef.current || !enabledRef.current) return
      const json = JSON.stringify(data)
      if (json === lastJsonRef.current) {
        // Back to what the server already holds. Cancel the queued write as
        // well as skipping this one: typing a line and then deleting it again
        // would otherwise let the intermediate value land after the edit that
        // undid it.
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = null
        pendingRef.current = null
        return
      }
      pendingRef.current = json
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void drain()
      }, DEBOUNCE_MS)
    },
    [drain],
  )

  const clear = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    pendingRef.current = null
    lastJsonRef.current = null
    setSavedAt(null)
    setSaveStatus('idle')
    setLoaded((current) => (current ? { key: current.key, restored: null } : current))
    if (hasStoredRef.current) {
      hasStoredRef.current = false
      await clearPageState(keyRef.current)
    }
  }, [])

  // Load once per key. The sequence guard is the same idea the quote builder
  // already uses for its SKU fetch: a slow answer for a previous key must not
  // land on top of the current one.
  const loadSeqRef = useRef(0)
  useEffect(() => {
    keyRef.current = pageKey
    const seq = ++loadSeqRef.current
    stoppedRef.current = false
    loadedRef.current = false
    lastJsonRef.current = null
    hasStoredRef.current = false

    let cancelled = false
    void (async () => {
      // Yield one macrotask before touching the server.
      //
      // This effect can mount on a page the user reached through a redirect
      // (/quotes -> /quotes/board), and calling a Server Action while Next's
      // own Router is still committing that navigation makes the Router throw
      //   "Rendered more hooks than during the previous render."  (React #310)
      // from inside itself, which the browser shows as "This page couldn't
      // load. Reload to try again, or go back." Reproduced on Next 16.2.9 with
      // this hook in the quotes tab bar; removing the yield brings it straight
      // back. Waiting for the current task to finish puts the call safely
      // after the commit, and costs a tick nobody can perceive.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (cancelled || seq !== loadSeqRef.current) return

      const result = await loadPageState(pageKey)
      if (cancelled || seq !== loadSeqRef.current) return

      let value: RestoredState<T> | null = null
      if (result.ok && result.state) {
        let parsed: T | null = null
        try {
          parsed = parseRef.current(result.state.data)
        } catch {
          parsed = null
        }
        if (parsed !== null) {
          hasStoredRef.current = true
          // Recorded as already-persisted so the page applying the draft to its
          // own state does not immediately write the same thing straight back.
          lastJsonRef.current = JSON.stringify(parsed)
          value = {
            data: parsed,
            savedAt: result.state.updatedAt,
            stale: isStale(result.state.base, baseRef.current),
          }
        } else {
          // Stored under a shape this version cannot read. Leave the row alone
          // rather than deleting someone's work on a deploy; the next real save
          // overwrites it.
          hasStoredRef.current = true
        }
      }

      // Set BEFORE the callback, so anything the page saves in response to the
      // restore is written rather than held.
      loadedRef.current = true
      setSavedAt(value?.savedAt ?? null)
      setLoaded({ key: pageKey, restored: value })
      onRestoreRef.current?.(value)

      // Anything queued while the read was in flight is still waiting, and it
      // may be either of two very different things: what the user typed during
      // a slow read, or the page's empty defaults from before the restore
      // landed. Writing the second would delete the row that was just restored.
      //
      // So this ARMS the debounce rather than flushing. The page reacts to the
      // restore in the same tick, and its own save then either matches what the
      // server holds (cancelling this one) or replaces it with what was really
      // typed. Both cases resolve long before the timer fires.
      if (pendingRef.current !== null) {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          void drain()
        }, DEBOUNCE_MS)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pageKey, drain])

  // Stopping (a successful submit) must also kill anything already queued.
  useEffect(() => {
    if (!enabled && timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      pendingRef.current = null
    }
  }, [enabled])

  // Leaving the page flushes immediately instead of losing the debounce. On a
  // soft navigation the component unmounts but the browser tab lives on, so the
  // request completes. A hard close within the debounce window is the one case
  // that loses the last keystrokes, and is documented as such.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (pendingRef.current !== null && !stoppedRef.current && enabledRef.current) {
        void drain()
      }
    }
  }, [drain])

  return { status, restored, save, clear, saveStatus, savedAt }
}

/**
 * A filter, a tab, a search box: remembered silently.
 *
 * Renders `initial` at once so nothing waits on the network, then applies the
 * saved value when it arrives UNLESS the user has already changed the control,
 * which is what stops a slow read yanking a search box out from under someone
 * mid-type.
 */
export function usePersistedView<T>(
  pageKey: string,
  initial: T,
  parse: (raw: unknown) => T | null,
  options: { enabled?: boolean } = {},
): [T, (next: T) => void, boolean] {
  const enabled = options.enabled !== false
  const [value, setValue] = useState<T>(initial)
  const touchedRef = useRef(false)
  const initialJsonRef = useRef(JSON.stringify(initial))

  const { status, save } = usePageState<T>({
    pageKey,
    parse,
    enabled,
    onRestore: (restored) => {
      // Someone typing while the read was in flight keeps what they typed.
      if (restored && !touchedRef.current) setValue(restored.data)
    },
    // A view sitting at its defaults is worth nothing; do not keep a row.
    isEmpty: (v) => JSON.stringify(v) === initialJsonRef.current,
  })

  const set = useCallback(
    (next: T) => {
      touchedRef.current = true
      setValue(next)
      save(next)
    },
    [save],
  )

  return [value, set, status === 'ready']
}
