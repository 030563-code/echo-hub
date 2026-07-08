import 'server-only'

import { parseSpotIds, extractShipmentDetail, type CargoDetail } from './cargo-parse'
import { externalCallsDisabled } from './env'

// Server-only Cargo Partner client. Token + the two endpoints (lookup-by-reference
// → SPOT IDs, get-detail → container/ETA/vessel/event). Shared by the Transport
// manual lookup and the PO→shipment resolver/sweep so a batch can reuse one token.
//
// NB: the API doc says /shipments/lookup returns summary fields, but live it
// returns an ARRAY of SPOT-ID strings — so callers must fetchShipmentDetail for
// the rest. Wrap CARGO_PARTNER_PASSWORD in quotes in .env if it contains '#'.

const AUTH_URL = 'https://auth.cargo-partner.com/token'
const API = 'https://api.cargo-partner.com/transport/v1'

export async function getCargoToken(): Promise<string> {
  // Staging sandbox: never reach the live Cargo Partner API. Callers already
  // handle a token failure gracefully (lookup → no shipment shown).
  if (externalCallsDisabled()) throw new Error('Cargo Partner is disabled in the staging sandbox')
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.CARGO_PARTNER_USERNAME!,
      password: process.env.CARGO_PARTNER_PASSWORD!,
      grant_type: 'password',
      client_id: process.env.CARGO_PARTNER_CLIENT_ID!,
      client_secret: process.env.CARGO_PARTNER_CLIENT_SECRET!,
    }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error('Cargo Partner auth failed')
  return ((await res.json()) as { access_token: string }).access_token
}

/**
 * PO / general reference → Cargo Partner SPOT IDs (the lookup returns an array).
 * A 404 (or ok-but-empty) means "no shipment for this reference" → []. Any OTHER
 * non-2xx (e.g. a 500 outage) THROWS, so callers never mistake a server error for
 * "no shipment" and wipe a previously-resolved row.
 */
export async function fetchSpotIds(token: string, reference: string): Promise<string[]> {
  const res = await fetch(`${API}/shipments/lookup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: { referenceType: 'GENERAL_REFERENCE', referenceNumber: reference.trim() } }),
    cache: 'no-store',
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Cargo lookup failed: ${res.status}`)
  return parseSpotIds(await res.json())
}

/** SPOT ID → container / ETA / shipped / vessel / carrier / latest-event. Best-effort. */
export async function fetchShipmentDetail(token: string, spotId: string): Promise<CargoDetail> {
  try {
    const res = await fetch(`${API}/shipments/${encodeURIComponent(spotId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return {}
    return extractShipmentDetail(await res.json())
  } catch {
    return {}
  }
}
