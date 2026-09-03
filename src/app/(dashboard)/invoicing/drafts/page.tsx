import { redirect } from 'next/navigation'

/**
 * "Draft Invoices" was one list of everything in flight. It is now five stage
 * queues, because a single list could not answer "what is waiting for me".
 * Kept as a redirect so an existing bookmark still lands somewhere useful,
 * rather than 404ing.
 */
export default function DraftInvoicesRedirect() {
  redirect('/invoicing/tax-calculated')
}
