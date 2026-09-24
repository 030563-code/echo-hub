/**
 * The date printed on a supplier document.
 *
 * Dean, 18 Sep 2026, after Jozef at the factory: "Fix the order date so it is
 * the Date the PO was sent not just todays date." Until then both the -1
 * specification and the -3 accounting order stamped the moment of download, so
 * the same order read differently every time it was opened and never said
 * when it was actually placed.
 *
 * The send is the order date. Before an order has been sent there is no send,
 * so the day the manufacturing order was raised stands in: that is its issue
 * date, and it is stored. Until 24 Sep 2026 the stand-in was today, which was
 * the same fault one step earlier: an office preview of an unsent order read
 * differently every day it was opened.
 *
 * No clock is read here at all, and that is the point. Nothing about when
 * somebody downloads a document can move its date. Pure, so the choice is
 * testable without a database.
 */
export function supplierDocumentDate(
  sentAt: string | null | undefined,
  raisedAt: string | null | undefined,
): string {
  for (const value of [sentAt, raisedAt]) {
    const at = value ? new Date(value) : null
    if (at && !Number.isNaN(at.getTime())) return at.toISOString().slice(0, 10)
  }
  // purchase_orders.created_at is NOT NULL, so a real order never gets here. A
  // blank date is honest; today would be a guess printed as a fact.
  return ''
}
