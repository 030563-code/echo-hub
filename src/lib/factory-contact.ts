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
 * 🔴 IT CANNOT BE REPLACED, ONLY ADDED TO. The boxes on the order page were removed on 17 Sep and
 * put back the same day at Dean's request: "readd the ability to enter email addresses for to and
 * CC which will append to the existing ones". The difference from the original is the whole point.
 * They used to REPLACE the recipient, which meant any caller of that 'use server' export could
 * have the Hub send a real purchase order, on Echo Barrier letterhead, to an address of their
 * choosing and to nobody else. Now the factory's address and the four internal copies are decided
 * here and always go; anything typed is added to them.
 *
 * Testing still diverts everything: `resolveRecipients` sends to HUB_EMAIL_TEST_RECIPIENT when it
 * is set, so nothing reaches the factory while anybody is trying things out. That is the one email
 * switch for the whole Hub and this does not add a second.
 */

/** Their warehouse desk, which is where an order, a reminder and a chase all land. */
export const FACTORY_CONTACT = 'sklad@bamida.sk'

/**
 * Who at Echo Barrier is copied on everything that goes to the factory, always.
 *
 * Dean, 17 Sep 2026, naming them: "just make it clear that andy.murphy@echobarrier.com,
 * dave.lindsay@echobarrier.com, juraj@echobarrier.eu and operations@echobarrier.eu is
 * automatically CCed".
 *
 * In code rather than in an environment variable ON PURPOSE. "Make it clear" is the requirement,
 * and nobody can read a Netlify variable from the order screen. These four are printed on the page
 * before anything is sent, and they are printed again in the confirmation dialog.
 *
 * 🔴 Dean wrote dave.lindsay@echoabarrier.com, with an extra 'a'. His real address, from his own
 * Hub account, is dave.lindsay@echobarrier.com, which is what is used here. The typo would have
 * bounced silently on every order.
 */
export const ALWAYS_COPIED: readonly string[] = [
  'andy.murphy@echobarrier.com',
  'dave.lindsay@echobarrier.com',
  'juraj@echobarrier.eu',
  'operations@echobarrier.eu',
]

/**
 * Merge address lists, keeping the first spelling of each and ignoring case and blanks.
 *
 * Every list on this path is ADDITIVE, so a typed address can never drop one of the four, and
 * typing one of the four again cannot produce a duplicate copy.
 */
export function mergeAddresses(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const piece of String(list ?? '').split(',')) {
      const address = piece.trim()
      if (!address) continue
      const key = address.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(address)
    }
  }
  return out.join(', ')
}

/** The standing internal copies, plus anyone else the server is configured with. */
export function factoryCopyTo(): string {
  return mergeAddresses(ALWAYS_COPIED.join(', '), process.env.BAMIDA_PO_CC)
}
