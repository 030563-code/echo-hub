'use client'
// page-state: none (a link list and one form, both about this shipment only; a
// remembered draft would follow the user onto a different container)

import { useState, useTransition } from 'react'
import { Link2, Copy, Check, Ban } from 'lucide-react'
import { toast } from 'sonner'
import {
  createCargoShareLink,
  revokeCargoShareLink,
  type ShareLink,
} from '@/app/actions/cargo/share-link'

/**
 * Give somebody outside the company a view of this one container.
 *
 * The page it opens carries no prices, no weights, no bill of lading and no
 * company names: the route, where the container is, and when it is expected.
 * The label typed here is ours and is never shown to the person who opens it.
 */

const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'Until revoked', days: null },
]

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

export default function ShareLinkCard({
  spotId,
  initialLinks,
  canShare,
}: {
  spotId: string
  initialLinks: ShareLink[]
  canShare: boolean
}) {
  const [links, setLinks] = useState<ShareLink[]>(initialLinks)
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState<number | null>(90)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, start] = useTransition()

  const live = links.filter((l) => !l.revokedAt)

  function mint() {
    start(async () => {
      const res = await createCargoShareLink({
        spotId,
        label: label.trim() || undefined,
        expiresInDays: expiry,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setLinks([res.link, ...links])
      setLabel('')
      await navigator.clipboard.writeText(res.link.url).catch(() => {})
      toast.success('Link created and copied to your clipboard.')
    })
  }

  function revoke(token: string) {
    start(async () => {
      const res = await revokeCargoShareLink({ token })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setLinks(links.map((l) => (l.token === token ? { ...l, revokedAt: new Date().toISOString() } : l)))
      toast.success('Link revoked. It stops working immediately.')
    })
  }

  async function copy(url: string, token: string) {
    await navigator.clipboard.writeText(url).catch(() => {})
    setCopied(token)
    setTimeout(() => setCopied(null), 1500)
  }

  if (!canShare) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Share with a customer
        </h2>
        <p className="mt-2 text-sm text-gray-500">
          You can see this shipment but not share it. Sharing needs the organisation the container is bound for.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-1 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        Share with a customer
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        A link to this container only. No prices, no weights, no paperwork. Revoke it whenever you like.
      </p>

      <div className="space-y-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
          placeholder="Who is it for (only you see this)"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-[#025945] focus:outline-none"
        />
        <div className="flex flex-wrap gap-1">
          {EXPIRY_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => setExpiry(c.days)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                expiry === c.days
                  ? 'border-[#025945] bg-[#025945] text-white'
                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button
          onClick={mint}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#025945] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
        >
          <Link2 className="h-4 w-4" /> Create a tracking link
        </button>
      </div>

      {links.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-gray-100 pt-3">
          {links.map((l) => (
            <li key={l.token} className={l.revokedAt ? 'opacity-50' : ''}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-gray-900">{l.label || 'Untitled link'}</p>
                  <p className="text-xs text-gray-500">
                    {l.revokedAt
                      ? `Revoked ${when(l.revokedAt)}`
                      : l.expiresAt
                        ? `Expires ${when(l.expiresAt)}`
                        : 'No expiry'}
                    {' · '}
                    {l.viewCount === 0 ? 'not opened yet' : `opened ${l.viewCount} times`}
                  </p>
                </div>
                {!l.revokedAt && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => copy(l.url, l.token)}
                      title="Copy the link"
                      className="rounded-md border border-gray-300 p-1.5 text-gray-600 transition-colors hover:bg-gray-50"
                    >
                      {copied === l.token ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={() => revoke(l.token)}
                      disabled={busy}
                      title="Stop this link working"
                      className="rounded-md border border-gray-300 p-1.5 text-gray-600 transition-colors hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {live.length === 0 && links.length > 0 && (
        <p className="mt-3 text-xs text-gray-400">No link is working at the moment.</p>
      )}
    </section>
  )
}
