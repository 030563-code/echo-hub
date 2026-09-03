'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Copy, ExternalLink, FileText, Mail, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatMoney } from '@/lib/utils'
import { hubspotRecordUrl } from '@/lib/hubspot-links'
import { buildGmailComposeUrl, buildQuoteEmail } from '@/lib/gmail-compose'
import { markQuoteEmailComposed } from '@/app/actions/sales/quote-email'

/**
 * What the rep sees once a quote is live in HubSpot.
 *
 * This replaces the old ending, which downloaded a PDF, uploaded it to HubSpot
 * Files, attached it to a note and then pushed the rep out to HubSpot to send
 * it themselves. Now there is a hosted quote with a public link, and the send
 * is one click into a prefilled Gmail window.
 *
 * The email is composed, never sent. Nothing leaves the Hub until the rep
 * presses Send in their own mailbox, which is also what makes HubSpot log it:
 * the BCC address only works for mail sent from a connected inbox.
 */

export interface PublishedQuoteView {
  quoteId: string
  dealQuoteId: string
  quoteNumber: string | null
  quoteLink: string | null
  pdfLink: string | null
  amount: number | null
  hubAmount: number
  amountMismatch: boolean
  expiresOn: string
  currency: string
}

export interface QuoteEmailDefaults {
  contactFirstName?: string | null
  contactEmail?: string | null
  companyName?: string | null
  dealName: string
  repName?: string | null
  repPhone?: string | null
  repEmail?: string | null
  /** HubSpot's per-portal logging address. Absent just means the sent email is
   *  not logged; the quote still goes out. */
  bccAddress?: string | null
}

function longDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function QuotePublishedPanel({
  quote,
  email,
}: {
  quote: PublishedQuoteView
  email: QuoteEmailDefaults
}) {
  const defaults = buildQuoteEmail({
    contactFirstName: email.contactFirstName,
    companyName: email.companyName,
    dealName: email.dealName,
    quoteNumber: quote.quoteNumber,
    quoteLink: quote.quoteLink ?? '',
    expiresOn: longDate(quote.expiresOn),
    repName: email.repName,
    repPhone: email.repPhone,
  })

  const [showEmail, setShowEmail] = useState(false)
  const [to, setTo] = useState(email.contactEmail ?? '')
  const [subject, setSubject] = useState(defaults.subject)
  const [body, setBody] = useState(defaults.body)
  const [, startTransition] = useTransition()

  const hubspotUrl = hubspotRecordUrl('quote', quote.quoteId)

  function copyLink() {
    if (!quote.quoteLink) return
    navigator.clipboard.writeText(quote.quoteLink).then(
      () => toast.success('Quote link copied'),
      () => toast.error('Could not copy the link. Select it and copy by hand.'),
    )
  }

  function openGmail() {
    const url = buildGmailComposeUrl({
      to,
      bcc: email.bccAddress,
      subject,
      body,
      // Picks which signed-in account composes. Without it a rep signed into
      // two Google accounts can send from the wrong one, and HubSpot then logs
      // nothing because the sender is not the connected inbox.
      authuser: email.repEmail,
    })
    // Recorded but never blocking: a failed write must not stop the rep sending.
    startTransition(() => {
      void markQuoteEmailComposed(quote.dealQuoteId)
    })
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-4">
      <div>
        <p className="font-semibold text-green-900">
          Quote {quote.quoteNumber ?? ''} is live in HubSpot
        </p>
        <p className="text-sm text-green-800">
          {formatMoney(quote.amount ?? quote.hubAmount, quote.currency)}, valid until{' '}
          {longDate(quote.expiresOn)}. Nothing has been emailed yet.
        </p>
        {quote.amountMismatch && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            HubSpot totals this quote at {formatMoney(quote.amount ?? 0, quote.currency)} while the Hub
            calculated {formatMoney(quote.hubAmount, quote.currency)}. The customer sees HubSpot figure.
            Check the line items before sending.
          </p>
        )}
      </div>

      {quote.quoteLink ? (
        <p className="break-all rounded border border-green-200 bg-white px-3 py-2 font-mono text-xs text-gray-700">
          {quote.quoteLink}
        </p>
      ) : (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          HubSpot has not returned the public link yet. It usually appears within a few seconds.
          Reopen the deal to pick it up.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {quote.quoteLink && (
          <>
            <Button size="sm" variant="outline" onClick={copyLink}>
              <Copy className="mr-1.5 h-4 w-4" />
              Copy link
            </Button>
            <a href={quote.quoteLink} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="outline">
                <ExternalLink className="mr-1.5 h-4 w-4" />
                Open quote
              </Button>
            </a>
          </>
        )}
        {quote.pdfLink && (
          <a href={quote.pdfLink} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline">
              <FileText className="mr-1.5 h-4 w-4" />
              PDF
            </Button>
          </a>
        )}
        {hubspotUrl && (
          <a href={hubspotUrl} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline">
              <ExternalLink className="mr-1.5 h-4 w-4" />
              View in HubSpot
            </Button>
          </a>
        )}
        {quote.quoteLink && (
          <Button size="sm" onClick={() => setShowEmail((open) => !open)}>
            <Mail className="mr-1.5 h-4 w-4" />
            {showEmail ? 'Hide email' : 'Compose in Gmail'}
          </Button>
        )}
      </div>

      {showEmail && (
        <div className="space-y-3 rounded border border-green-200 bg-white p-3">
          <div>
            <Label htmlFor="emailTo" className="text-gray-900">To</Label>
            <Input id="emailTo" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="emailSubject" className="text-gray-900">Subject</Label>
            <Input id="emailSubject" value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="emailBody" className="text-gray-900">Message</Label>
            <Textarea id="emailBody" rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="mt-1" />
          </div>
          <p className="text-xs text-gray-500">
            {email.bccAddress
              ? `Opens Gmail in a new tab with ${email.bccAddress} on the BCC line, which is how HubSpot logs the sent email against the contact, its company and this deal. Nothing is sent until you press Send there.`
              : 'Opens Gmail in a new tab. Nothing is sent until you press Send there. No HubSpot logging address is configured, so this email will not appear on the deal timeline.'}
          </p>
          <Button size="sm" onClick={openGmail} disabled={!to.trim()}>
            <Mail className="mr-1.5 h-4 w-4" />
            Open Gmail
          </Button>
        </div>
      )}
    </div>
  )
}

/** Shown when the quote step failed. The deal, its line items and the Hub
 *  record are already saved, so the only thing to redo is the quote. */
export function QuoteFailedPanel({
  error,
  onRetry,
  retrying,
}: {
  error: string
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="font-semibold text-amber-900">The quote did not publish</p>
      <p className="text-sm text-amber-900">{error}</p>
      <p className="text-sm text-amber-800">
        The deal, its line items and the Hub record are all saved. Only the HubSpot quote needs
        redoing, and retrying picks up where it stopped rather than making a second one.
      </p>
      <Button size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={`mr-1.5 h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
        {retrying ? 'Retrying...' : 'Retry quote'}
      </Button>
    </div>
  )
}
