'use client'

// page-state: none (a two-field form that clears on save; the durable copy is the send_contact row)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'
import { addContactToBook } from '@/app/actions/purchase-orders/send-contacts'

/**
 * One row of the address book, as the send screens need it.
 *
 * Declared here rather than imported from the server module: `send-contacts.ts` carries
 * `import 'server-only'`, and a client component importing it, even for a type, breaks the build.
 */
export interface SendContactOption {
  id: string
  address: string
  displayName: string | null
  organisation: string | null
  field: 'to' | 'cc'
  defaultSelected: boolean
  isRequired: boolean
}

/**
 * Add somebody to the address book from the send screen.
 *
 * Dean, 17 Sep 2026: "the ability to add more to a library in supabase that adds to the tickbox".
 *
 * 🔴 A contact added here is never required and never pre-ticked. Required means "on every order
 * the Hub ever sends", and that is not a decision anybody should be able to make in passing while
 * sending one purchase order. Tick them for this send; if they belong on every order, that is a
 * change somebody makes deliberately in the table.
 */
export default function AddSendContact({ channel }: { channel: 'manufacturing' | 'cargo' }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [organisation, setOrganisation] = useState('')
  const [field, setField] = useState<'to' | 'cc'>('cc')
  const [pending, start] = useTransition()

  const input =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange'

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900"
      >
        <Plus className="h-3.5 w-3.5" />
        Add somebody to the list
      </button>
    )
  }

  function save() {
    start(async () => {
      const res = await addContactToBook({ channel, address, displayName: name, organisation, field })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success('Added to the list. Tick them to include them on this order.')
      setAddress('')
      setName('')
      setOrganisation('')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
        Add somebody to the list
      </p>
      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        <input
          className={input}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="name@company.com"
          disabled={pending}
          aria-label="Email address"
        />
        <input
          className={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Their name (optional)"
          disabled={pending}
          aria-label="Name"
        />
        <input
          className={input}
          value={organisation}
          onChange={(e) => setOrganisation(e.target.value)}
          placeholder="Who they work for (optional)"
          disabled={pending}
          aria-label="Organisation"
        />
        <select
          className={input}
          value={field}
          onChange={(e) => setField(e.target.value === 'to' ? 'to' : 'cc')}
          disabled={pending}
          aria-label="Send to or copy to"
        >
          <option value="cc">Copy to</option>
          <option value="to">Send to</option>
        </select>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        They are added unticked. Nothing is sent to them until you tick them, on this order or any
        other.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !address.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-[#025945] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#03674f] disabled:opacity-50"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Add
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
