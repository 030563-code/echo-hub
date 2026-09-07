// Deployment-environment helpers.
//
// NEXT_PUBLIC_HUB_ENV drives BOTH the visible "staging sandbox" banner and the
// server-side kill switch that suppresses every outbound call to an external
// platform (Xero via n8n, HubSpot CRM, Cargo Partner, the manufacturing
// Supabase). Set it to "staging" on the staging Netlify site; leave it unset
// (or "production") everywhere else. It is a NEXT_PUBLIC_* var so the client
// bundle can render the banner — it holds no secret.

export type HubEnv = 'production' | 'staging'

export function hubEnv(): HubEnv {
  return process.env.NEXT_PUBLIC_HUB_ENV === 'staging' ? 'staging' : 'production'
}

export function isStaging(): boolean {
  return hubEnv() === 'staging'
}

/**
 * TRUE when the app must NOT touch any external platform (Xero via n8n, HubSpot,
 * Cargo Partner, the manufacturing Supabase). This is belt-and-suspenders ON TOP
 * of simply not setting those credentials on the staging site: even if a
 * production token is mis-pasted into the staging environment, no call fires.
 */
export function externalCallsDisabled(): boolean {
  return isStaging()
}

/** Uniform message returned when an external hand-off is skipped in staging. */
export const STAGING_SKIP_NOTE =
  'Sandbox (staging): the live hand-off was skipped — nothing was sent to Xero, HubSpot or Cargo Partner.'
