'use client'

// page-state: view calls:contacts (the search box)

import { useMemo, useState } from 'react'
import { Card } from '@/components/ui/card'
import { hubspotRecordUrl } from '@/lib/hubspot-links'
import { Button } from '@/components/ui/button'
import { SearchBox } from '@/components/ui/search-box'
import { usePersistedView } from '@/hooks/use-page-state'
import { parseSearchView, type SearchView } from '@/lib/page-drafts'
import type { PlaceholderContact } from '@/lib/calls/placeholders'
import { LinkContactDialog } from '../link-contact-dialog'

/**
 * The contacts the phone system created from a number alone.
 *
 * This is the backlog: the phone system has been minting these since May 2026,
 * and 220 of the 221 in the portal have no call attached, because call logging
 * only started working on 15 September. They cannot be worked from the call
 * list, which is why they have a page of their own.
 */
export function PlaceholderContactsClient({
  contacts,
  totalInPortal,
  error,
  canSeeNothing,
}: {
  contacts: PlaceholderContact[]
  totalInPortal: number
  error: string | null
  canSeeNothing: boolean
}) {
  const [view, setView] = usePersistedView<SearchView>('calls:contacts', { v: 1, q: '' }, parseSearchView)
  const [linking, setLinking] = useState<PlaceholderContact | null>(null)

  const shown = useMemo(() => {
    const needle = view.q.trim().toLowerCase()
    if (needle === '') return contacts
    return contacts.filter((c) => `${c.phone ?? ''} ${c.country ?? ''}`.toLowerCase().includes(needle))
  }, [contacts, view.q])

  if (canSeeNothing) {
    return (
      <Card className="border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-700">
          No region is set on your profile, so there is nothing to show you yet. Ask Dean to set your
          sales region.
        </p>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-gray-200 bg-white p-6">
        <p className="text-sm text-red-700">{error}</p>
      </Card>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-gray-600">
          {contacts.length} of the {totalInPortal} contacts HubSpot holds with a phone number and
          nothing else are for your offices. Each one is somebody who rang in and did not match anyone
          in HubSpot at the time. Link one to the contact you created and the two become a single
          record.
        </p>
        <SearchBox value={view.q} onChange={(q) => setView({ v: 1, q })} placeholder="Number or country…" />
      </div>

      {shown.length === 0 ? (
        <Card className="border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">
            {contacts.length === 0 ? 'Nothing waiting. Every number the phone system saw is on a real contact.' : 'Nothing matches that.'}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden border-gray-200 bg-white p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-2.5 text-left font-medium">Number</th>
                  <th className="px-3 py-2.5 text-left font-medium">Office</th>
                  <th className="px-3 py-2.5 text-left font-medium">First seen</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="border-t border-gray-100">
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-900">
                      {c.actionable ? c.phone : <span className="text-gray-400">no usable number</span>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-700">{c.office ?? c.country ?? '—'}</td>
                    <td className="px-3 py-2.5 text-gray-600">
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-3">
                        <a
                          href={hubspotRecordUrl("contact", c.id) ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-gray-500 hover:underline"
                        >
                          HubSpot
                        </a>
                        <Button variant="outline" onClick={() => setLinking(c)} disabled={!c.actionable}>
                          Link to a contact
                        </Button>
                      </div>
                    </td>
                  </tr>
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
        placeholderId={linking?.id}
        subject={linking ? `${linking.phone ?? 'no number'}, ${linking.office ?? linking.country ?? 'unknown office'}` : ''}
      />
    </div>
  )
}
