import { Info } from 'lucide-react'

/**
 * A filter that emptied the list, said out loud.
 *
 * Typing a company name that matches no company in HubSpot is not an error:
 * the answer really is "no deals". But an empty table with no explanation
 * reads as a broken page, and the rep has no way to tell a genuinely empty
 * result from a filter that silently failed. This says which one it was.
 */
export function FilterNotice({ notice }: { notice?: string }) {
  if (!notice) return null
  return (
    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{notice}</p>
    </div>
  )
}
