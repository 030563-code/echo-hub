import 'server-only'

/**
 * The line descriptions HubSpot holds, for the deal lines an invoice is built
 * from.
 *
 * deals_registry.line_items_raw is written by the HubSpot sync, and that sync
 * does not ask for the `description` property. So the descriptions exist in
 * HubSpot (the Full Size Cutting Station carries "10'L x 7'W x 6'H FULL
 * ENCLOSED CUTTING STATION; FIRE, UV, and WATER RESISTENT") and simply never
 * reach the Hub, which is why every invoice line came through with a blank
 * description. Reading them here fixes the deals already in the registry too,
 * rather than only the ones synced after a change to the sync.
 *
 * Fails soft on purpose: a draft must not depend on HubSpot being reachable,
 * and a missing description is a blank field, never a blocked invoice.
 */

/** HubSpot's batch read caps at 100 inputs per call. */
const BATCH = 100

export async function fetchHubSpotLineDescriptions(
  lineItemIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(lineItemIds.map((id) => String(id ?? '').trim()).filter((id) => id !== ''))]
  if (ids.length === 0) return out

  const token = process.env.HUBSPOT_ACCESS_TOKEN
  if (!token) return out

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    try {
      const response = await fetch('https://api.hubapi.com/crm/v3/objects/line_items/batch/read', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: chunk.map((id) => ({ id })), properties: ['description'] }),
        cache: 'no-store',
      })
      if (!response.ok) {
        // Never log the body: HubSpot echoes the request back on some errors.
        console.error('fetchHubSpotLineDescriptions failed', response.status)
        continue
      }
      const data = (await response.json()) as {
        results?: { id?: string; properties?: { description?: string | null } }[]
      }
      for (const row of data.results ?? []) {
        const id = String(row.id ?? '').trim()
        const description = String(row.properties?.description ?? '').trim()
        if (id !== '' && description !== '') out.set(id, description)
      }
    } catch (err) {
      console.error('fetchHubSpotLineDescriptions threw', err instanceof Error ? err.message : 'unknown')
    }
  }
  return out
}
