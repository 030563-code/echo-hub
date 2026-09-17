// Shared route-loading skeleton. Rendered by each segment's loading.tsx as the
// Suspense fallback while the server component + its data fetch resolve, so a
// navigation shows an immediate themed placeholder instead of a frozen page.

export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  const bar = "bg-gray-200";
  const barSoft = "bg-gray-100";
  const border = "border-gray-200";
  const rowBorder = "border-gray-100";

  return (
    <div className="animate-pulse" aria-hidden="true" role="status" aria-label="Loading">
      {/* title + subtitle */}
      <div className={`h-7 w-56 rounded ${bar} mb-2.5`} />
      <div className={`h-3.5 w-80 max-w-full rounded ${barSoft} mb-6`} />

      {/* table-ish card */}
      <div className={`rounded-xl border ${border} overflow-hidden`}>
        <div className={`h-9 ${barSoft} border-b ${border}`} />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={`flex items-center gap-4 px-4 py-3.5 border-t ${rowBorder}`}>
            <div className={`h-3.5 w-24 rounded ${bar}`} />
            <div className={`h-3.5 w-40 max-w-[30%] rounded ${barSoft}`} />
            <div className={`h-3.5 w-16 rounded ${barSoft}`} />
            <div className={`h-3.5 w-20 rounded ${bar} ml-auto`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A form or editor being loaded: a stack of labelled field groups.
 *
 * Dean, 17 Sep 2026: "The edit specification should also have some ghost screen that gives the
 * user feedback on it loading so should every other screen really."
 *
 * 🔴 A route with no loading.tsx of its own inherits the NEAREST ancestor's, and in the App Router
 * that is a real boundary, not a fallback: opening the specification editor drew the purchase
 * order KANBAN BOARD, so a form looked like the list you had just navigated away from. A detail or
 * form route under a list route needs its own, always.
 */
export function FormSkeleton({ groups = 3, rows = 4 }: { groups?: number; rows?: number }) {
  return (
    <div className="space-y-5" role="status" aria-label="Loading">
      <div className="h-14 rounded-lg border border-gray-200 bg-gray-50" />
      {Array.from({ length: groups }).map((_, g) => (
        <div key={g} className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="h-3.5 w-40 rounded bg-gray-200 animate-pulse" />
          <div className="mt-3 space-y-2">
            {Array.from({ length: rows }).map((_, r) => (
              <div key={r} className="flex gap-2">
                <div className="h-8 w-44 shrink-0 rounded bg-gray-100 animate-pulse" />
                <div className="h-8 flex-1 rounded bg-gray-100 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * One record and the things you can do to it: a header, a column of actions, and cards.
 * Used by the single purchase order and the factory's single order page.
 */
export function DetailSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div role="status" aria-label="Loading">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1">
          <div className="h-6 w-56 rounded bg-gray-200 animate-pulse" />
          <div className="mt-2 h-3.5 w-72 max-w-full rounded bg-gray-100 animate-pulse" />
          <div className="mt-2.5 flex gap-1.5">
            <div className="h-5 w-20 rounded-md bg-gray-100 animate-pulse" />
            <div className="h-5 w-24 rounded-md bg-gray-100 animate-pulse" />
          </div>
        </div>
        <div className="w-full space-y-2 sm:w-56">
          <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
          <div className="h-9 w-full rounded-lg bg-gray-100 animate-pulse" />
        </div>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
            <div className="mt-4 space-y-2.5">
              {Array.from({ length: 4 }).map((_, r) => (
                <div key={r} className="h-3.5 w-full rounded bg-gray-100 animate-pulse" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
