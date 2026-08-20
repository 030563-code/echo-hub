import 'server-only'

/**
 * Resolves the HubSpot owner id for a user's email via the owners API.
 * Returns null when the email has no HubSpot seat (or the lookup fails) —
 * callers that scope visibility by owner must FAIL CLOSED on null for
 * non-admins, or the scoping silently degrades.
 */
// Owner ids are effectively immutable, and the search path calls this per
// debounced keystroke — memoize per server instance. Failures are NOT cached,
// so a transient owners-API blip doesn't pin a user to fail-closed.
const ownerIdCache = new Map<string, string>()

export async function resolveHubSpotOwnerId(
  email: string,
  accessToken: string
): Promise<string | null> {
  if (!email) return null
  const cached = ownerIdCache.get(email)
  if (cached) return cached
  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/owners/?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' }
    )
    if (!response.ok) return null
    const data = await response.json()
    const id = data.results?.[0]?.id
    if (!id) return null
    ownerIdCache.set(email, String(id))
    return String(id)
  } catch (error) {
    console.error('HubSpot owner lookup failed:', error)
    return null
  }
}
