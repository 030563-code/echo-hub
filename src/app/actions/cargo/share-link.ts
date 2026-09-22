'use server'

import { randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { hubBaseUrl } from '@/lib/env'
import { depotsForOrgs, transportSeesAllFor, type OrgCode } from '@/lib/organisations'

/**
 * Links that let somebody outside the company watch one container.
 *
 * 🔴 THE SCOPE PROBLEM, AND WHY THIS IS A LINK AND NOT A LOGIN. No shipment
 * table in this database carries a customer. Not cargo_shipment, not
 * shipment_contents, not po_shipments, not the operations table Dave's workflow
 * fills. The only thread back to an order is general_reference, which is free
 * text, is present on 9 shipments in 25, and holds two order numbers in one
 * comma-separated string when a container carries two. "Show a customer their
 * shipments" therefore cannot be answered from the data, and answering it anyway
 * means someday showing somebody a container that is not theirs.
 *
 * "Show this person this one shipment" can be answered. So a link is minted for
 * one shipment by somebody who already holds transport.view and who holds the
 * organisation the shipment is bound for, it can expire, it can be revoked, and
 * the page it opens carries no prices. That is a smaller promise than a customer
 * account and it is one the data actually supports.
 */

const MintSchema = z.object({
  spotId: z.string().trim().min(1).max(64),
  /** Our own note on who it is for. Never rendered on the shared page. */
  label: z.string().trim().max(120).optional(),
  /** Null or absent means it runs until somebody revokes it. */
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
})

const RevokeSchema = z.object({ token: z.string().trim().min(32).max(200) })

export interface ShareLink {
  token: string
  url: string
  label: string | null
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastViewedAt: string | null
  viewCount: number
}

/** The depots the caller may act on, or null when they see every shipment. */
async function transportScope(): Promise<
  { ok: true; depots: readonly string[] | null; uid: string } | { ok: false; error: string }
> {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !auth.capabilities.has('transport.view')) {
    return { ok: false, error: 'You do not have access to transport.' }
  }
  const held = auth.profile.organisations as OrgCode[]
  // Every container leaves s.r.o. and belongs to Group on the way, so those two
  // see all of them; anyone else sees what is bound for their own depots.
  return {
    ok: true,
    depots: transportSeesAllFor(held) ? null : depotsForOrgs(held),
    uid: auth.user.id,
  }
}

async function shipmentInScope(spotId: string, depots: readonly string[] | null): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin.from('cargo_shipment').select('destination_depot').eq('spot_id', spotId).maybeSingle()
  if (!data) return false
  if (!depots) return true
  const depot = (data as { destination_depot: string | null }).destination_depot
  return Boolean(depot && depots.includes(depot))
}

function shareUrl(token: string): string {
  return `${hubBaseUrl()}/track/${token}`
}

function toShareLink(row: Record<string, unknown>): ShareLink {
  const token = String(row.token)
  return {
    token,
    url: shareUrl(token),
    label: (row.label as string | null) ?? null,
    createdAt: String(row.created_at),
    expiresAt: (row.expires_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    lastViewedAt: (row.last_viewed_at as string | null) ?? null,
    viewCount: Number(row.view_count ?? 0),
  }
}

/** Mint a link for one shipment. 32 random bytes, so it cannot be guessed. */
export async function createCargoShareLink(
  input: z.infer<typeof MintSchema>,
): Promise<{ ok: true; link: ShareLink } | { ok: false; error: string }> {
  const parsed = MintSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That request did not make sense.' }

  const scope = await transportScope()
  if (!scope.ok) return scope
  if (!(await shipmentInScope(parsed.data.spotId, scope.depots))) {
    return { ok: false, error: 'That shipment is not one of yours.' }
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString()
    : null

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('cargo_share_link')
    .insert({
      token,
      spot_id: parsed.data.spotId,
      label: parsed.data.label ?? null,
      created_by_uid: scope.uid,
      expires_at: expiresAt,
    })
    .select('*')
    .single()

  if (error || !data) return { ok: false, error: 'Could not create the link.' }
  revalidatePath(`/transport/${parsed.data.spotId}`)
  return { ok: true, link: toShareLink(data as Record<string, unknown>) }
}

/** Stop a link working. Kept rather than deleted, so the history stays readable. */
export async function revokeCargoShareLink(
  input: z.infer<typeof RevokeSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = RevokeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That request did not make sense.' }

  const scope = await transportScope()
  if (!scope.ok) return scope

  const admin = createAdminClient()
  const { data: link } = await admin
    .from('cargo_share_link')
    .select('spot_id')
    .eq('token', parsed.data.token)
    .maybeSingle()
  if (!link) return { ok: false, error: 'That link no longer exists.' }

  const spotId = (link as { spot_id: string }).spot_id
  if (!(await shipmentInScope(spotId, scope.depots))) {
    return { ok: false, error: 'That shipment is not one of yours.' }
  }

  await admin
    .from('cargo_share_link')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token', parsed.data.token)
    .is('revoked_at', null)

  revalidatePath(`/transport/${spotId}`)
  return { ok: true }
}

/** Every link ever minted for one shipment, newest first. */
export async function listCargoShareLinks(
  spotId: string,
): Promise<{ ok: true; links: ShareLink[] } | { ok: false; error: string }> {
  const scope = await transportScope()
  if (!scope.ok) return scope
  if (!(await shipmentInScope(spotId, scope.depots))) {
    return { ok: false, error: 'That shipment is not one of yours.' }
  }

  const admin = createAdminClient()
  const { data } = await admin
    .from('cargo_share_link')
    .select('*')
    .eq('spot_id', spotId)
    .order('created_at', { ascending: false })

  return { ok: true, links: ((data ?? []) as Record<string, unknown>[]).map(toShareLink) }
}
