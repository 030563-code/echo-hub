/**
 * Jack, the ANZ AI sales agent, as a Hub user: who he is and what he may never
 * do.
 *
 * Jack holds a real Supabase auth user so that createQuote runs under RLS
 * exactly as it does for a rep. That user is a machine identity and must never
 * be a person sitting in the Hub. Two things stop it, and both are needed:
 *
 *  1. Supabase side: the login address has no MX record, so the magic link and
 *     password-recovery mail anyone can trigger with the public anon key lands
 *     nowhere. That is the jack_cutover migration's job.
 *  2. Hub side, here: any browser session carrying this user id is refused at
 *     the middleware and at the auth callback, and its cookies are cleared. So
 *     even a session obtained some other way buys nothing in the UI.
 *
 * Kept deliberately free of imports (no 'server-only', no Supabase, no zod) so
 * the Edge middleware can use it without pulling a bundle in behind it.
 *
 * This module reads JACK_USER_ID, the same variable the quote route needs to
 * work at all. Unset, the route fails closed (500 INTERNAL on every call) AND
 * the lockout is off, because with no id to compare against no session can be
 * the agent's.
 *
 * That pairing is only safe where both are off together. A Netlify DEPLOY
 * PREVIEW is the case where they are not: the preview runs against PRODUCTION
 * Supabase, so the Jack auth user is real there even though the preview's own
 * route is dead. JACK_USER_ID is an id, not a secret, so it belongs in the
 * preview context too and the cutover notes say so. Keep AGENT_QUOTE_SECRET
 * production-only: that is what stops a preview raising a real quote.
 */

export function agentUserId(): string {
  return String(process.env.JACK_USER_ID ?? '').trim()
}

/** True when this id is the agent's. False for everyone else, and false when
 *  JACK_USER_ID is unset, because then no id can be the agent's. */
export function isAgentUserId(userId: string | null | undefined): boolean {
  const agent = agentUserId()
  if (agent === '') return false
  return String(userId ?? '').trim() === agent
}

/**
 * The address a quote raised by the agent should print as its sender.
 *
 * Jack has TWO addresses and they are different on purpose.
 *
 *  - The MAIL identity, JACK_SENDER_EMAIL, is jack.walker@echobarrier.com. It
 *    is a real Gmail alias: the From header on every customer email and the
 *    address printed on the quote as the person to reply to. This function
 *    returns that one.
 *  - The LOGIN identity, JACK_AUTH_EMAIL, is jack.agent@no-mail.echobarrier.com
 *    and it must never be deliverable. Anyone can ask Supabase for a magic link
 *    or a password reset for a known address with the public anon key, so a
 *    mailbox behind the login address hands a full Jack session to whoever can
 *    read it. That is why it is NOT auth.users.email that gets printed here.
 *
 * createQuote copies the sender email onto the customer's quote, so printing
 * the login address would tell a customer to reply into a domain with no MX.
 *
 * Returns null for everyone who is not the agent, meaning "nothing to override",
 * and null for the agent when the variable is unset, which omits the sender
 * email rather than printing the no-mail one. HubSpot then falls back to the
 * quote template and the deal owner.
 */
export function agentSenderEmail(userId: string | null | undefined): string | null {
  if (!isAgentUserId(userId)) return null
  const email = String(process.env.JACK_SENDER_EMAIL ?? '').trim()
  return email === '' ? null : email
}
