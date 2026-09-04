import 'server-only'

import { ownerSignatureName, type HubSpotOwner } from '@/lib/hubspot-owners'

/**
 * The name of the HubSpot account a quote email is sent from.
 *
 * The quote email opens in the rep's own Gmail, so the person signing it is the
 * signed-in user. The Hub used to sign it with `profiles.display_name`, which is
 * a Hub-local field nobody keeps in step with HubSpot, and a quote went out
 * signed with a colleague's name. HubSpot owns who the sender is, so ask it.
 *
 * Never throws and never blocks a quote: any failure returns null and the caller
 * falls back to the profile name. A quote that publishes with a slightly stale
 * signature beats one that will not publish at all.
 */
export async function hubspotSenderName(email: string | null | undefined): Promise<string | null> {
  const address = String(email ?? '').trim()
  if (address === '') return null

  const token = process.env.HUBSPOT_ACCESS_TOKEN
  if (!token) return null

  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(address)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    )
    if (!response.ok) return null

    const body = (await response.json()) as { results?: HubSpotOwner[] }
    const results = Array.isArray(body.results) ? body.results : []
    // An archived owner is still the right name for a person who is still
    // sending mail from that mailbox, so only the live one is preferred rather
    // than required.
    const owner = results.find((o) => o?.archived !== true) ?? results[0]
    return ownerSignatureName(owner)
  } catch {
    return null
  }
}
