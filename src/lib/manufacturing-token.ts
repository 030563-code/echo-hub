import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { hubBaseUrl } from '@/lib/env'

/**
 * The link Bamida use to reach one purchase order.
 *
 * No account, no session, no navigation into the Hub. The token names exactly
 * one order and the page it opens can read nothing else.
 *
 * REUSABLE, deliberately. Bamida come back: once to give their dates, again
 * when the order is finished. last_used_at is kept as a record and is never
 * consulted as a gate; expiry and revocation are the gates.
 */

/** How long a link stays good. Generous on purpose: a build takes weeks. */
const DEFAULT_DAYS = 180

export function linkLifetimeDays(): number {
  const configured = Number(process.env.MANUFACTURING_LINK_DAYS ?? '')
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_DAYS
}

/** Only the hash is ever stored, so a copy of the table is not a set of links. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export type MintedLink = { url: string; expiresAt: string }

/**
 * Mint a link for one manufacturing order. Existing live links for that order
 * are revoked first, so a resend cannot leave two working links in two inboxes
 * with nobody sure which one is current.
 */
export async function mintManufacturingLink(poId: string, createdBy: string | null): Promise<MintedLink | null> {
  const admin = createAdminClient()
  const nowIso = new Date().toISOString()

  await admin
    .from('manufacturing_access_tokens')
    .update({ revoked_at: nowIso })
    .eq('po_id', poId)
    .is('revoked_at', null)

  const raw = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + linkLifetimeDays() * 24 * 60 * 60 * 1000).toISOString()

  const { error } = await admin.from('manufacturing_access_tokens').insert({
    token_hash: hashToken(raw),
    po_id: poId,
    expires_at: expiresAt,
    created_by: createdBy,
  })
  if (error) {
    console.error('mintManufacturingLink failed', error.message)
    return null
  }

  return { url: `${hubBaseUrl()}/manufacturing/${raw}`, expiresAt }
}

export type ResolvedToken =
  | { ok: true; poId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' }

/**
 * Turn a raw token into the one order it may touch.
 *
 * A wrong token and a revoked one are told apart here so the page can say
 * something true, but neither ever reveals which order the link belonged to.
 */
export async function resolveManufacturingToken(raw: string): Promise<ResolvedToken> {
  const token = String(raw ?? '').trim()
  if (token === '') return { ok: false, reason: 'unknown' }

  const { data } = await createAdminClient()
    .from('manufacturing_access_tokens')
    .select('id, po_id, expires_at, revoked_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle()
  if (!data) return { ok: false, reason: 'unknown' }
  if (data.revoked_at !== null) return { ok: false, reason: 'revoked' }
  if (new Date(data.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  // A record, not a gate. Best-effort: a failed touch must never lock anybody
  // out of a link that is otherwise perfectly valid.
  await createAdminClient()
    .from('manufacturing_access_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)

  return { ok: true, poId: String(data.po_id) }
}
