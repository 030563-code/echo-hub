'use client'

/**
 * The Xero customer behind the invoice.
 *
 * Xero holds the billing address, the accounts-payable email the invoice is
 * sent to, and the payment terms the due date comes from. Those are read live
 * rather than copied into our schema, so what Dave sees here is what Xero
 * actually holds. If the account number is not in Xero yet, the same fields
 * become a create form, so a missing customer does not send anyone off to
 * another system mid-invoice.
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { lookupInvoiceContact, saveInvoiceContact } from '@/app/actions/invoicing/xero-contact'
import { describeTerms, DEFAULT_PAYMENT_TERM_DAYS } from '@/lib/customer-invoice/payment-terms'
import type { XeroContact } from '@/lib/xero-hub'

type Status = 'idle' | 'found' | 'missing' | 'error'

interface Form {
  name: string
  email: string
  line1: string
  line2: string
  city: string
  region: string
  postal_code: string
  country: string
  terms_day: string
  terms_type: string
}

const EMPTY: Form = {
  name: '', email: '', line1: '', line2: '', city: '', region: '',
  postal_code: '', country: 'USA', terms_day: '', terms_type: 'DAYSAFTERBILLDATE',
}

function toForm(c: XeroContact, fallbackName: string): Form {
  return {
    name: c.name ?? fallbackName,
    email: c.email ?? '',
    line1: c.address?.line1 ?? '',
    line2: c.address?.line2 ?? '',
    city: c.address?.city ?? '',
    region: c.address?.region ?? '',
    postal_code: c.address?.postal_code ?? '',
    country: c.address?.country ?? 'USA',
    terms_day: c.payment_terms?.day != null ? String(c.payment_terms.day) : '',
    terms_type: c.payment_terms?.type ?? 'DAYSAFTERBILLDATE',
  }
}

export function XeroContactCard({
  accountNumber,
  companyName,
  editable,
}: {
  accountNumber: string
  companyName: string | null
  editable: boolean
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [contactId, setContactId] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const account = accountNumber.trim()

  const load = useCallback(() => {
    // No state is written before the first await. This runs from a mount
    // effect, and setting state synchronously there triggers cascading
    // renders; the spinner rides on `pending` instead. The no-account case
    // needs no state at all, because the render branches on `account`.
    if (!account) return
    startTransition(async () => {
      const res = await lookupInvoiceContact({ accountNumber: account })
      if (!res.success) {
        setStatus('error')
        setError(res.error)
        return
      }
      setError(null)
      if (res.found) {
        setContactId(res.contact.contact_id)
        setForm(toForm(res.contact, companyName ?? ''))
        setStatus('found')
      } else {
        setContactId(null)
        setForm({ ...EMPTY, name: companyName ?? '' })
        setStatus('missing')
      }
    })
  }, [account, companyName])

  useEffect(() => {
    load()
  }, [load])

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const onSave = () =>
    startTransition(async () => {
      const day = form.terms_day.trim()
      const res = await saveInvoiceContact({
        contactId,
        accountNumber: account,
        name: form.name.trim(),
        email: form.email.trim() || null,
        address: {
          line1: form.line1.trim() || null,
          line2: form.line2.trim() || null,
          city: form.city.trim() || null,
          region: form.region.trim() || null,
          postal_code: form.postal_code.trim() || null,
          country: form.country.trim() || null,
        },
        paymentTerms: day === '' ? null : { day: Number(day), type: form.terms_type },
      })
      if (!res.success) {
        toast.error(res.error)
        return
      }
      setContactId(res.contact.contact_id)
      setForm(toForm(res.contact, companyName ?? ''))
      setStatus('found')
      toast.success(contactId ? 'Xero contact updated.' : 'Xero contact created.')
    })

  const field = (key: keyof Form, label: string, placeholder?: string) => (
    <div>
      <Label htmlFor={`xc-${key}`}>{label}</Label>
      <Input
        id={`xc-${key}`}
        value={form[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)}
        placeholder={placeholder}
        disabled={!editable || pending}
      />
    </div>
  )

  return (
    <Card className="bg-white border-gray-200 p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-900">Customer in Xero</h2>
        <div className="flex items-center gap-2">
          {pending && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          {status === 'found' && !pending && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Found in Xero
            </span>
          )}
          {status === 'missing' && !pending && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              Not in Xero yet
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={load} disabled={!account || pending} title="Re-read from Xero">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <p className="mb-4 text-xs text-gray-500">
        {status === 'missing'
          ? `Xero has no customer with account number ${account}. Fill these in and create it without leaving the Hub.`
          : 'Read live from Xero. The email is where the invoice is sent, and the terms set the due date.'}
      </p>

      {!account ? (
        <p className="text-sm text-amber-700">
          Set the Xero account number above before the customer can be looked up.
        </p>
      ) : status === 'error' ? (
        <div className="flex items-start gap-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {field('name', 'Company name')}
            {field('email', 'Invoice email', 'accountspayable@example.com')}
            {field('line1', 'Invoice address')}
            {field('line2', 'Address line 2')}
            {field('city', 'City')}
            {field('region', 'State')}
            {field('postal_code', 'Zip')}
            {field('country', 'Country')}
            <div>
              <Label htmlFor="xc-terms-day">Payment terms</Label>
              <Input
                id="xc-terms-day"
                value={form.terms_day}
                onChange={(e) => set({ terms_day: e.target.value.replace(/\D/g, '') })}
                placeholder={String(DEFAULT_PAYMENT_TERM_DAYS)}
                disabled={!editable || pending}
              />
            </div>
            <div>
              <Label htmlFor="xc-terms-type">Terms basis</Label>
              <select
                id="xc-terms-type"
                value={form.terms_type}
                onChange={(e) => set({ terms_type: e.target.value })}
                disabled={!editable || pending}
                className="w-full border-b-2 border-echo-border bg-white px-0 py-2.5 text-sm text-echo-dark focus:border-echo-orange focus:outline-none disabled:text-gray-400"
              >
                <option value="DAYSAFTERBILLDATE">Days after the invoice date</option>
                <option value="DAYSAFTERBILLMONTH">Days after the end of the invoice month</option>
                <option value="OFCURRENTMONTH">Day of the invoice month</option>
                <option value="OFFOLLOWINGMONTH">Day of the following month</option>
              </select>
            </div>
          </div>

          <p className="mt-3 text-xs text-gray-500">
            Due date will be{' '}
            <span className="font-medium text-gray-700">
              {describeTerms(
                form.terms_day.trim() === '' ? null : { day: Number(form.terms_day), type: form.terms_type },
              )}
            </span>
            , counted from the date the invoice is sent.
          </p>

          {editable && (
            <div className="mt-4 flex justify-end">
              <Button onClick={onSave} disabled={pending || !form.name.trim()}>
                {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {status === 'missing' ? 'Create in Xero' : 'Save to Xero'}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
