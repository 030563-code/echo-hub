'use client'

import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { createHubSpotCompany } from '@/app/actions/hubspot/createCompany'
import { searchCompanies } from '@/app/actions/hubspot/searchCompanies'
import { createHubSpotContact } from '@/app/actions/hubspot/createContact'

/**
 * Both dialogs below write to the LIVE shared HubSpot portal — there is no
 * test environment — so each one makes the rep look at the exact values
 * before anything is sent, and both server actions dedup (company by
 * name+domain, contact by email) and may hand back an EXISTING record rather
 * than a new one. The success copy stays neutral ("Linked to…") on purpose
 * so it never claims a creation that didn't happen.
 */

interface NameConflict {
  id: string
  name: string
  domain: string
}

export interface CreatedCompany {
  id: string
  name: string
  domain: string
}

interface CreateCompanyDialogProps {
  /** Prefills the Name field from whatever the rep already typed in the search box. */
  initialName: string
  /** Shared with the rest of the form so a double-click here can't double-create. */
  inFlightRef: RefObject<boolean>
  onCreated: (company: CreatedCompany) => void
  /** True when company visibility is scoped to the caller's own records. */
  restrictedToOwn?: boolean
}

export function CreateCompanyDialog({ initialName, inFlightRef, onCreated, restrictedToOwn = true }: CreateCompanyDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(initialName)
  const [domain, setDomain] = useState('')
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [nameConflicts, setNameConflicts] = useState<NameConflict[] | null>(null)

  const handleOpenChange = (next: boolean) => {
    // A write already sent to HubSpot cannot be called back, so don't let the
    // dialog close mid-flight and imply it was cancelled.
    if (!next && pending) return
    if (next) {
      setNameConflicts(null)
      setName(initialName)
      setDomain('')
      setTouched(false)
    }
    setOpen(next)
  }

  const trimmedName = name.trim()
  const trimmedDomain = domain.trim()
  const isValid = trimmedName.length > 0 && trimmedDomain.length > 0

  const runCreate = async (force: boolean) => {
    setTouched(true)
    if (!isValid) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    setPending(true)
    try {
      // Look for a company already carrying this exact name. The server-side
      // dedup only matches when the domain agrees too, so without this a
      // corrected domain quietly creates a second record for one business.
      if (!force) {
        const existing = await searchCompanies(trimmedName)
        if (!existing.success) {
          // A failed check is NOT a clean check — proceeding would silently
          // skip the only guard against a domain-variant duplicate.
          toast.error(
            'Could not check for an existing company: ' +
              (existing.error ?? 'unknown error') +
              '. Please try again.'
          )
          return
        }
        const target = trimmedName.toLowerCase()
        const sameName = (existing.data ?? []).filter(
          (c) => c.name.trim().toLowerCase() === target && c.source === 'hubspot'
        )
        const conflicting = sameName.filter(
          (c) => (c.domain ?? '').trim().toLowerCase() !== trimmedDomain.toLowerCase()
        )
        if (conflicting.length > 0) {
          setNameConflicts(conflicting.map((c) => ({ id: c.id, name: c.name, domain: c.domain ?? '' })))
          return
        }
      }
      const result = await createHubSpotCompany({ name: trimmedName, domain: trimmedDomain })
      if (result.success && result.companyId) {
        const actual = result.company ?? { name: trimmedName, domain: trimmedDomain }
        toast.success(
          result.matchedExisting
            ? `Using the existing "${actual.name}" already in HubSpot`
            : `Created ${actual.name} in HubSpot`
        )
        onCreated({ id: result.companyId, name: actual.name, domain: actual.domain })
        setOpen(false)
      } else {
        toast.error('Failed to create company: ' + (result.error ?? 'Unknown error'))
      }
    } catch (error: unknown) {
      toast.error(
        'Failed to create company: ' + (error instanceof Error ? error.message : String(error))
      )
    } finally {
      inFlightRef.current = false
      setPending(false)
    }
  }

  const handleConfirm = () => runCreate(false)

  const handleUseExisting = (match: NameConflict) => {
    onCreated({ id: match.id, name: match.name, domain: match.domain })
    setNameConflicts(null)
    setOpen(false)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => handleOpenChange(true)}
        className="w-full sm:w-auto py-3 sm:py-2 max-sm:text-sm border-gray-300 text-gray-700 hover:bg-gray-50"
      >
        <Plus className="w-4 h-4 mr-1.5" />
        Create new company
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[425px] bg-white text-gray-900 border-gray-200">
          <DialogHeader>
            <DialogTitle className="text-gray-900">Create new company</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-gray-700">Company Name *</Label>
              <Input
                placeholder="Acme Corp"
                className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameConflicts(null)
                }}
              />
              {touched && !trimmedName && <p className="text-xs text-red-600">Company name is required.</p>}
            </div>

            <div className="space-y-2">
              <Label className="text-gray-700">Company Domain *</Label>
              <Input
                placeholder="example.com"
                className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value)
                  setNameConflicts(null)
                }}
              />
              {touched && !trimmedDomain && <p className="text-xs text-red-600">Company domain is required.</p>}
            </div>

            {nameConflicts && nameConflicts.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                <p>
                  {restrictedToOwn ? 'You already have' : 'HubSpot already has'}{' '}
                  {nameConflicts.length === 1 ? 'a company' : `${nameConflicts.length} companies`} called{' '}
                  <span className="font-semibold">{trimmedName}</span>, with a different domain. Use
                  the existing record unless this really is a separate business.
                </p>
                <ul className="space-y-1">
                  {nameConflicts.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => handleUseExisting(c)}
                        className="w-full min-h-11 break-words text-left rounded border border-amber-300 bg-white px-3 py-2 hover:bg-amber-100"
                      >
                        <span className="font-semibold text-gray-900">{c.name}</span>
                        <span className="text-gray-600">{c.domain ? ` — ${c.domain}` : ' — no domain'}</span>
                        <span className="block text-xs text-amber-800">Use this company</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isValid && !nameConflicts && (
              <div className="rounded-md border border-echo-yellow/40 bg-echo-yellow/5 p-3 text-sm text-gray-700 break-words">
                You are about to add this company to HubSpot:{' '}
                <span className="font-semibold text-gray-900">
                  {trimmedName} — {trimmedDomain}
                </span>
                . This writes to the live CRM. If a company with this name and domain already
                exists you&apos;ll be linked to it instead of creating a duplicate.
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
              className="py-3 sm:py-2.5 border-gray-300 text-gray-700 disabled:opacity-60"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={nameConflicts ? () => runCreate(true) : handleConfirm}
              disabled={pending}
              className="py-3 sm:py-2.5 bg-echo-yellow text-black hover:bg-echo-yellow/90 font-bold disabled:opacity-60"
            >
              {pending
                ? 'Creating…'
                : nameConflicts
                  ? 'Create a separate company anyway'
                  : 'Create company'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export interface CreatedContact {
  id: string
  firstname: string
  lastname: string
  email: string
}

interface CreateContactDialogProps {
  companyId: string
  companyName: string
  inFlightRef: RefObject<boolean>
  onCreated: (contact: CreatedContact) => void
}

export function CreateContactDialog({ companyId, companyName, inFlightRef, onCreated }: CreateContactDialogProps) {
  const [open, setOpen] = useState(false)
  const [firstname, setFirstname] = useState('')
  const [lastname, setLastname] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)

  const handleOpenChange = (next: boolean) => {
    if (!next && pending) return
    if (next) {
      setFirstname('')
      setLastname('')
      setEmail('')
      setPhone('')
      setTouched(false)
    }
    setOpen(next)
  }

  const trimmedFirst = firstname.trim()
  const trimmedLast = lastname.trim()
  const trimmedEmail = email.trim()
  const isValid = trimmedFirst.length > 0 && trimmedLast.length > 0 && trimmedEmail.length > 0

  const handleConfirm = async () => {
    setTouched(true)
    if (!isValid) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    setPending(true)
    try {
      const result = await createHubSpotContact({
        firstname: trimmedFirst,
        lastname: trimmedLast,
        email: trimmedEmail,
        phone: phone.trim() || undefined,
        companyId,
      })
      if (result.success && result.contactId) {
        const actual =
          result.contact ?? { firstname: trimmedFirst, lastname: trimmedLast, email: trimmedEmail }
        const actualName = `${actual.firstname} ${actual.lastname}`.trim() || actual.email
        // On a dedup hit the stored record can be a DIFFERENT person to the one
        // typed (same email, different name), and that is the record the deal
        // will attach to — so say whose record it is rather than echoing input.
        toast.success(
          result.matchedExisting
            ? `That email already belongs to ${actualName}, so they were linked to ${companyName}`
            : `Created ${actualName} at ${companyName}`
        )
        onCreated({
          id: result.contactId,
          firstname: actual.firstname,
          lastname: actual.lastname,
          email: actual.email,
        })
        setOpen(false)
      } else {
        toast.error('Failed to create contact: ' + (result.error ?? 'Unknown error'))
      }
    } catch (error: unknown) {
      toast.error(
        'Failed to create contact: ' + (error instanceof Error ? error.message : String(error))
      )
    } finally {
      inFlightRef.current = false
      setPending(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => handleOpenChange(true)}
        className="w-full sm:w-auto py-3 sm:py-2 max-sm:text-sm border-gray-300 text-gray-700 hover:bg-gray-50"
      >
        <Plus className="w-4 h-4 mr-1.5" />
        Add new contact to {companyName}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[425px] bg-white text-gray-900 border-gray-200">
          <DialogHeader>
            <DialogTitle className="text-gray-900">Add new contact</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-gray-700">First Name *</Label>
                <Input
                  placeholder="John"
                  className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                  value={firstname}
                  onChange={(e) => setFirstname(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-gray-700">Last Name *</Label>
                <Input
                  placeholder="Doe"
                  className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                  value={lastname}
                  onChange={(e) => setLastname(e.target.value)}
                />
              </div>
            </div>
            {touched && (!trimmedFirst || !trimmedLast) && (
              <p className="text-xs text-red-600 -mt-2">First and last name are required.</p>
            )}

            <div className="space-y-2">
              <Label className="text-gray-700">Email *</Label>
              <Input
                type="email"
                placeholder="john@example.com"
                className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {touched && !trimmedEmail && <p className="text-xs text-red-600">Email is required.</p>}
            </div>

            <div className="space-y-2">
              <Label className="text-gray-700">Phone</Label>
              <Input
                placeholder="Optional"
                className="bg-white border-gray-300 text-gray-900 focus:ring-echo-yellow"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            {isValid && (
              <div className="rounded-md border border-echo-yellow/40 bg-echo-yellow/5 p-3 text-sm text-gray-700 break-words">
                You are about to add this contact to HubSpot:{' '}
                <span className="font-semibold text-gray-900">
                  {trimmedFirst} {trimmedLast} — {trimmedEmail}
                </span>
                , linked to <span className="font-semibold text-gray-900">{companyName}</span>. This writes to the
                live CRM. If this email already exists you&apos;ll be linked to that person instead of
                creating a duplicate.
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
              className="py-3 sm:py-2.5 border-gray-300 text-gray-700 disabled:opacity-60"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={pending}
              className="py-3 sm:py-2.5 bg-echo-yellow text-black hover:bg-echo-yellow/90 font-bold disabled:opacity-60"
            >
              {pending ? 'Creating…' : 'Create contact'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
