import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { bearerAuthorized } from '@/lib/machine-auth'
import { callPayloadSchema, toCallRow } from '@/lib/calls/payload'
import { readContact } from '@/lib/calls/hubspot-contact'

// ---------------------------------------------------------------------------
// POST /api/calls/ingest — every sales call, from the phone system.
//
// The country handlers already POST a full call payload (transcript, English
// translation, summary, recording, caller, office, department, and the HubSpot
// contact they matched or created) to an n8n webhook whose output is wired to
// nothing. This is where that payload is meant to land.
//
// Auth: `authorization: Bearer ${CALLS_INGEST_SECRET}`, constant time, failing
// closed when the variable is unset (see src/lib/machine-auth.ts). This path is
// listed in SELF_AUTHENTICATED_PATHS in src/middleware.ts: without that a
// cookieless POST is redirected to /login, and because a redirect chain ends in
// a 200 HTML page, n8n would record every dropped call as a success.
//
// Idempotent on call_sid. n8n retries, Twilio retries and manual replays all
// land on the same row, and a second delivery may only add to it: the RPC never
// blanks a transcript and never undoes a link a rep has already made.
// ---------------------------------------------------------------------------

/** A body larger than this is not a call, it is a mistake. USA transcripts with
 *  their HTML are the big ones, and they are ~50 KB. */
const MAX_BODY_BYTES = 1_000_000

export async function POST(request: Request) {
  if (!bearerAuthorized(request.headers.get('authorization'), process.env.CALLS_INGEST_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'body too large' }, { status: 413 })
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'body is not json' }, { status: 400 })
  }

  const parsed = callPayloadSchema.safeParse(body)
  if (!parsed.success) {
    // The message is safe to return: n8n's execution log is where somebody will
    // read it, and it names a field, not a secret.
    const issue = parsed.error.issues[0]
    console.error('calls ingest rejected a payload', { issue: issue?.message, path: issue?.path })
    return NextResponse.json({ error: issue?.message ?? 'invalid payload' }, { status: 400 })
  }

  // The contact snapshot, best effort. It is what lets the link rules see that
  // a contact the phone system reported as "matched" is actually a placeholder.
  // A HubSpot failure must never cost us the call, so this is fail-open.
  const contactId = parsed.data.hubspot_contact_id?.trim()
  const snapshot = contactId ? await readContact(contactId) : null

  const row = toCallRow(parsed.data, { now: new Date(), contact: snapshot?.contact ?? null })

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('hub_ingest_phone_call', {
    p: {
      ...row,
      contact_firstname: snapshot?.contact?.firstname ?? null,
      contact_lastname: snapshot?.contact?.lastname ?? null,
      contact_email: snapshot?.contact?.email ?? null,
      contact_phone: snapshot?.contact?.phone ?? null,
      contact_snapshot_at: snapshot?.ok ? new Date().toISOString() : null,
    },
  })

  if (error) {
    console.error('calls ingest could not store the call', {
      call_sid: row.call_sid,
      error: error.message,
    })
    return NextResponse.json({ error: 'could not store the call' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) })
}
