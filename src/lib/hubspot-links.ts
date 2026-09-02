/**
 * Canonical HubSpot record URLs.
 *
 * The deal URL was hand-built in two places with the legacy `/deal/{id}` path.
 * That still redirects, but `/company/{id}` and `/contact/{id}` are the shapes
 * HubSpot has broken before, so everything here uses the durable object-type
 * form: record/0-3 deals, 0-2 companies, 0-1 contacts.
 *
 * Returns null when the portal id is unset rather than emitting a URL that
 * lands on a HubSpot error page. Both existing call sites already guarded on
 * the env var; this centralises that check so a new call site cannot forget it.
 */

const OBJECT_TYPE_IDS = {
  deal: "0-3",
  company: "0-2",
  contact: "0-1",
} as const

export type HubSpotRecordKind = keyof typeof OBJECT_TYPE_IDS

export function hubspotRecordUrl(kind: HubSpotRecordKind, id: string | null | undefined): string | null {
  const portalId = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
  const recordId = String(id ?? "").trim()
  if (!portalId || !recordId) return null
  return `https://app.hubspot.com/contacts/${portalId}/record/${OBJECT_TYPE_IDS[kind]}/${recordId}`
}
