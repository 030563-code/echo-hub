/**
 * The date printed on a supplier document.
 *
 * Dean, 18 Sep 2026, after Jozef at the factory: "Fix the order date so it is
 * the Date the PO was sent not just todays date." Until then both the -1
 * specification and the -3 accounting order stamped the moment of download, so
 * the same order read differently every time it was opened and never said
 * when it was actually placed.
 *
 * The send is the order date. Before an order has been sent there is no such
 * moment, so an office preview of an unsent order still shows today, which is
 * what a draft is. Pure, so the choice is testable without a database.
 */
export function supplierDocumentDate(sentAt: string | null | undefined, now: Date): string {
  const sent = sentAt ? new Date(sentAt) : null
  const date = sent && !Number.isNaN(sent.getTime()) ? sent : now
  return date.toISOString().slice(0, 10)
}
