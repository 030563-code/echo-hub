/**
 * The one address at the manufacturer.
 *
 * Dean, 17 Sep 2026: "here is the absolute point of contact to Bamida / sklad@bamida.sk / It
 * should no longer be an editable field. In the future everything will go to him."
 *
 * Everything means: the purchase order notification, the reminder when their own stock reading
 * goes low, the follow-up when an order runs past its estimated finish, and the chasing for
 * estimated start and finish dates and for the finished stamp. One address, one person
 * accountable, and nothing for anybody at the Hub to type differently on a Friday afternoon.
 *
 * 🔴 IT IS NOT AN INPUT. It was a pair of editable boxes on the order page and a pair of optional
 * fields on `sendManufacturingPoToBamida`, which meant a caller could have the Hub send a real
 * purchase order to any address at all. Both are gone: the recipient is decided here, on the
 * server, and no caller can name one.
 *
 * Testing still diverts everything: `resolveRecipients` sends to HUB_EMAIL_TEST_RECIPIENT when it
 * is set, so nothing reaches the factory while anybody is trying things out. That is the one email
 * switch for the whole Hub and this does not add a second.
 */

/** Their warehouse desk, which is where an order, a reminder and a chase all land. */
export const FACTORY_CONTACT = 'sklad@bamida.sk'

/**
 * Who at Echo Barrier is copied on what goes to the factory. Configurable because it is OUR side
 * of the correspondence and it changes when somebody joins or leaves; the factory's address does
 * not.
 */
export function factoryCopyTo(): string {
  return String(process.env.BAMIDA_PO_CC ?? '').trim()
}
