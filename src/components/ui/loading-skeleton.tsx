// Shared route-loading skeleton. Rendered by each segment's loading.tsx as the
// Suspense fallback while the server component + its data fetch resolve, so a
// navigation shows an immediate themed placeholder instead of a frozen page.
// `dark` matches the ERP module surface (#111); light is the dashboard/quotes shell.

export function PageSkeleton({ dark = false, rows = 6 }: { dark?: boolean; rows?: number }) {
  const bar = dark ? "bg-[#242424]" : "bg-gray-200";
  const barSoft = dark ? "bg-[#1a1a1a]" : "bg-gray-100";
  const border = dark ? "border-[#2a2a2a]" : "border-gray-200";
  const rowBorder = dark ? "border-[#222]" : "border-gray-100";

  return (
    <div className={`${dark ? "p-6" : ""} animate-pulse`} aria-hidden="true" role="status" aria-label="Loading">
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
