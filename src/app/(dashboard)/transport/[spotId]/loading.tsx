/**
 * The detail page's own skeleton.
 *
 * A dynamic route with no loading.tsx inherits its ANCESTOR's, which here would
 * draw the shipment list over the top of one shipment. tests/unit/route-loading-guard
 * exists because that has already happened once.
 */
export default function Loading() {
  return (
    <div className="animate-pulse p-6">
      <div className="mb-4 h-4 w-28 rounded bg-gray-200" />
      <div className="mb-5 h-8 w-64 rounded bg-gray-200" />
      <div className="mb-5 h-14 rounded-xl bg-gray-100" />
      <div className="mb-5 h-40 rounded-xl bg-gray-100" />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="h-64 rounded-xl bg-gray-100 lg:col-span-2" />
        <div className="h-64 rounded-xl bg-gray-100" />
      </div>
    </div>
  )
}
