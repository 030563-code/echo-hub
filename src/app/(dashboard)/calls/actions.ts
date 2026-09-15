'use server'

/**
 * The calls page's writes: say why a call was missed, link a call's placeholder
 * contact to the real one, or take a call out of the queue.
 *
 * The linking is the point of the page. The phone system creates a contact from
 * a phone number when it cannot match one; the rep has already created the real
 * contact, with an email and no phone. HubSpot's merge is what makes them one
 * record: the rep's contact survives and keeps its own values, the phone fills
 * the field it did not have, every association (the call itself, any deal, any
 * email) moves across, and the placeholder is archived. One request, atomic, and
 * it is the operation HubSpot built for this. Copy-then-delete would strand
 * whatever else was hanging off the placeholder, and the call engagement is
 * attached to the placeholder, so archiving it by hand would take the call with
 * it, which is the opposite of what Dean asked for.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { hubspotFetch, HubSpotConfigError } from '@/lib/hubspot-client'
import { officesForOrgs } from '@/lib/organisations'
import { isMissedCall, isPlaceholderContact } from '@/lib/calls/link-state'
import { isMissedReasonCode, missedReasonLabel, MISSED_REASON_CODES } from '@/lib/calls/missed-reasons'
import { readContact } from '@/lib/calls/hubspot-contact'

export type CallActionResult<T = undefined> =
  | ({ success: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { success: false; error: string; needsConfirmation?: { calls: number; deals: number } }

const CallId = z.string().uuid()

/**
 * Capability check, then the call itself, then the office check.
 *
 * The office check is not decoration: without it a crafted id would reach a
 * call belonging to a region this person may not see, which is the whole of the
 * scoping rule undone by one uuid.
 */
async function gateCall(callId: string) {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  if (!auth.capabilities.has('calls.view') && !auth.capabilities.has('admin')) {
    return { ok: false as const, error: 'You do not have access to calls.' }
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('hub_calls')
    .select(
      'id, call_sid, office, call_type, call_status, caller_phone, link_state, hubspot_contact_id, missed_reason, contact_email',
    )
    .eq('id', callId)
    .maybeSingle()

  if (error) {
    console.error('calls: could not read the call', { callId, error: error.message })
    return { ok: false as const, error: 'Could not read that call. Please try again.' }
  }
  if (!data) return { ok: false as const, error: 'That call is no longer in the Hub.' }

  // Every office of every organisation this person holds, not only the one
  // they are looking at: a rep may act on any call they can see.
  const offices = officesForOrgs(auth.profile.organisations)
  if (!offices.includes(data.office as (typeof offices)[number])) {
    // Deliberately the same message as a missing call: whether a call exists in
    // another region is not this person's business either.
    return { ok: false as const, error: 'That call is no longer in the Hub.' }
  }

  return {
    ok: true as const,
    admin,
    uid: auth.user.id,
    who: auth.user.email ?? 'a Hub user',
    call: data,
  }
}

// ---------------------------------------------------------------------------
// Why a call was missed. Dean, 15 Sep 2026: the rep gives a reason BEFORE the
// call can be linked to a contact.
// ---------------------------------------------------------------------------
const MissedInput = z.object({
  callId: CallId,
  reason: z.string().refine(isMissedReasonCode, {
    message: `Pick one of: ${MISSED_REASON_CODES.join(', ')}`,
  }),
  note: z.string().trim().max(500).optional(),
})

export async function recordMissedReason(input: unknown): Promise<CallActionResult> {
  const parsed = MissedInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid reason' }
  const { callId, reason, note } = parsed.data

  const g = await gateCall(callId)
  if (!g.ok) return { success: false, error: g.error }

  const { error } = await g.admin
    .from('hub_calls')
    .update({
      missed_reason: reason,
      missed_note: note?.trim() || null,
      missed_reason_by_uid: g.uid,
      missed_reason_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', callId)

  if (error) {
    console.error('calls: could not save the missed reason', { callId, error: error.message })
    return { success: false, error: 'Could not save the reason. Please try again.' }
  }

  // Also on the call in HubSpot, so the reason is where the call is. Best
  // effort: the Hub's record is the one that gates the linking.
  await appendToCallBody(
    g.call.hubspot_contact_id,
    g.call.call_sid,
    `Missed call reason (Hub, ${g.who}): ${missedReasonLabel(reason)}${note?.trim() ? `. ${note.trim()}` : ''}`,
  )

  revalidatePath('/calls')
  return { success: true }
}

// ---------------------------------------------------------------------------
// The link. One HubSpot merge, then the Hub's own record of what happened.
// ---------------------------------------------------------------------------
const LinkInput = z.object({
  callId: CallId,
  contactId: z.string().regex(/^\d{1,20}$/, 'Not a HubSpot contact id'),
  /** The email the rep actually saw. If the contact has changed underneath
   *  them, the merge must not go ahead on yesterday's information. */
  contactEmail: z.string().trim().email().max(320),
  /** Set once the rep has seen how much else moves with this merge. */
  confirmExtra: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
})

export async function linkCallToContact(input: unknown): Promise<CallActionResult<{ mergedInto: string }>> {
  const parsed = LinkInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { callId, contactId, contactEmail, confirmExtra, note } = parsed.data

  const g = await gateCall(callId)
  if (!g.ok) return { success: false, error: g.error }
  const call = g.call

  if (call.link_state === 'linked') {
    return { success: false, error: 'This call has already been linked.' }
  }
  if (!call.hubspot_contact_id) {
    return { success: false, error: 'The phone system never attached a contact to this call, so there is nothing to merge.' }
  }
  if (call.hubspot_contact_id === contactId) {
    return { success: false, error: 'That is the placeholder itself. Pick the contact you created.' }
  }
  if (isMissedCall(call) && !call.missed_reason) {
    return { success: false, error: 'Say why this call was missed first.' }
  }

  // The contact the rep picked has to be the real one: an email, and not
  // another Unknown Caller record. Merging two placeholders makes a worse
  // record than leaving the call alone.
  const target = await readContact(contactId)
  if (target.notFound) return { success: false, error: 'That contact no longer exists in HubSpot.' }
  if (!target.ok || !target.contact) return { success: false, error: target.error ?? 'Could not read that contact.' }
  if ((target.contact.email ?? '').trim().toLowerCase() !== contactEmail.toLowerCase()) {
    return { success: false, error: 'That contact changed while you were looking at it. Search again.' }
  }
  if (isPlaceholderContact(target.contact)) {
    return {
      success: false,
      error: 'That is another Unknown Caller record. Pick the contact with the email address on it.',
    }
  }

  // How much moves with the merge. One placeholder usually carries a whole
  // number's history, and under the withheld-caller defect it can carry calls
  // that have nothing to do with each other.
  if (!confirmExtra) {
    const blast = await countAssociations(call.hubspot_contact_id)
    if (blast.calls > 1 || blast.deals > 0) {
      return {
        success: false,
        error: `This number carries ${blast.calls} calls and ${blast.deals} deals. Merging moves all of them onto ${contactEmail}.`,
        needsConfirmation: blast,
      }
    }
  }

  // The merge itself.
  try {
    const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/contacts/merge', {
      method: 'POST',
      body: JSON.stringify({ primaryObjectId: contactId, objectIdToMerge: call.hubspot_contact_id }),
    })
    if (!response.ok) {
      const body = await response.text()
      console.error('calls: HubSpot refused the merge', {
        callId,
        status: response.status,
        body: body.slice(0, 300),
      })
      return {
        success: false,
        error:
          response.status === 409
            ? 'HubSpot says these are already merged. Reload the page.'
            : 'HubSpot refused the merge. Merge the two contacts by hand in HubSpot, then mark this call as linked.',
      }
    }
  } catch (error) {
    if (error instanceof HubSpotConfigError) return { success: false, error: error.message }
    console.error('calls: the merge threw', { callId, error: error instanceof Error ? error.message : error })
    return { success: false, error: 'HubSpot could not be reached. Nothing was changed.' }
  }

  const now = new Date().toISOString()
  const { error } = await g.admin
    .from('hub_calls')
    .update({
      link_state: 'linked',
      linked_contact_id: contactId,
      merged_contact_id: call.hubspot_contact_id,
      // Point at the survivor, so the list stops showing a name that HubSpot no
      // longer has.
      hubspot_contact_id: contactId,
      contact_firstname: target.contact.firstname,
      contact_lastname: target.contact.lastname,
      contact_email: target.contact.email,
      contact_phone: target.contact.phone,
      contact_snapshot_at: now,
      linked_by_uid: g.uid,
      linked_at: now,
      link_note: note?.trim() || null,
      updated_at: now,
    })
    .eq('id', callId)

  if (error) {
    // The merge already happened, so this is a record-keeping failure, not a
    // CRM one. Say so plainly rather than implying nothing changed.
    console.error('calls: merged in HubSpot but could not record it', { callId, error: error.message })
    return {
      success: false,
      error: 'The contacts were merged in HubSpot, but the Hub could not record it. Reload the page.',
    }
  }

  // Every other call sitting on that placeholder belongs to the same person.
  const { error: siblingError } = await g.admin
    .from('hub_calls')
    .update({
      hubspot_contact_id: contactId,
      linked_contact_id: contactId,
      merged_contact_id: call.hubspot_contact_id,
      link_state: 'linked',
      linked_by_uid: g.uid,
      linked_at: now,
      link_note: `Linked with call ${call.call_sid}`,
      updated_at: now,
    })
    .eq('hubspot_contact_id', call.hubspot_contact_id)
    .neq('id', callId)
    .neq('link_state', 'linked')

  if (siblingError) {
    console.error('calls: could not relink the other calls on that number', siblingError.message)
  }

  await appendToCallBody(contactId, call.call_sid, `Linked to ${contactEmail} in the Echo Barrier Hub by ${g.who}.`)

  revalidatePath('/calls')
  return { success: true, data: { mergedInto: contactId } }
}

// ---------------------------------------------------------------------------
// Out of the queue without a merge: a wrong number, a cold seller.
// ---------------------------------------------------------------------------
const IgnoreInput = z.object({
  callId: CallId,
  state: z.enum(['ignored', 'needs_link']),
  note: z.string().trim().max(300).optional(),
})

export async function setCallLinkState(input: unknown): Promise<CallActionResult> {
  const parsed = IgnoreInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { callId, state, note } = parsed.data

  const g = await gateCall(callId)
  if (!g.ok) return { success: false, error: g.error }
  if (g.call.link_state === 'linked') {
    return { success: false, error: 'This call has been linked. Undo it in HubSpot if that was wrong.' }
  }

  const { error } = await g.admin
    .from('hub_calls')
    .update({ link_state: state, link_note: note?.trim() || null, updated_at: new Date().toISOString() })
    .eq('id', callId)

  if (error) {
    console.error('calls: could not change the link state', { callId, error: error.message })
    return { success: false, error: 'Could not update that call. Please try again.' }
  }

  revalidatePath('/calls')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Finding the contact the rep created. Email first, because that is the field
// Dean named as the thing the two records have in common.
// ---------------------------------------------------------------------------
const SearchInput = z.object({ query: z.string().trim().min(3).max(120) })

export interface ContactHit {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  isPlaceholder: boolean
}

export async function findContactsForCall(input: unknown): Promise<CallActionResult<ContactHit[]>> {
  const parsed = SearchInput.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Type at least three characters' }

  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!auth.capabilities.has('calls.view') && !auth.capabilities.has('admin')) {
    return { success: false, error: 'You do not have access to calls.' }
  }

  const q = parsed.data.query
  const filter = (propertyName: string) => ({
    filters: [{ propertyName, operator: 'CONTAINS_TOKEN', value: `${q}*` }],
  })

  try {
    const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        // Email first: it is the connecting factor between the rep's contact
        // and the call. Name search is there because people search by name.
        filterGroups: [filter('email'), filter('firstname'), filter('lastname')],
        properties: ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company'],
        limit: 20,
      }),
    })
    if (!response.ok) {
      console.error('calls: contact search failed', response.status)
      return { success: false, error: 'HubSpot could not be searched right now.' }
    }
    const data = (await response.json()) as { results?: { id: string; properties: Record<string, string | null> }[] }
    const hits = (data.results ?? []).map((r) => {
      const p = r.properties ?? {}
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim()
      return {
        id: r.id,
        name: name === '' ? '(no name)' : name,
        email: p.email ?? null,
        phone: p.phone ?? p.mobilephone ?? null,
        company: p.company ?? null,
        isPlaceholder: isPlaceholderContact({ firstname: p.firstname, lastname: p.lastname, email: p.email }),
      }
    })
    return { success: true, data: hits }
  } catch (error) {
    if (error instanceof HubSpotConfigError) return { success: false, error: error.message }
    console.error('calls: contact search threw', error instanceof Error ? error.message : error)
    return { success: false, error: 'HubSpot could not be reached.' }
  }
}

// ---------------------------------------------------------------------------
// Helpers that talk to HubSpot about the call engagement itself.
// ---------------------------------------------------------------------------

/** How much else is attached to a contact, so a rep can see it before merging. */
async function countAssociations(contactId: string): Promise<{ calls: number; deals: number }> {
  const read = async (objectType: string): Promise<number> => {
    try {
      const response = await hubspotFetch(
        `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${objectType}?limit=100`,
      )
      if (!response.ok) return 0
      const data = (await response.json()) as { results?: unknown[] }
      return (data.results ?? []).length
    } catch {
      return 0
    }
  }
  const [calls, deals] = await Promise.all([read('calls'), read('deals')])
  return { calls, deals }
}

/**
 * Add a line to the call's own record in HubSpot.
 *
 * The call logger never tells anyone the engagement id it created, so the call
 * has to be found: it is the one on this contact whose body carries
 * "Twilio Call SID: <sid>", which the logger writes verbatim. Best effort
 * throughout. The merge and the Hub's own record are what matter; an annotation
 * that fails costs nothing.
 */
async function appendToCallBody(contactId: string | null, callSid: string, line: string): Promise<void> {
  if (!contactId) return
  try {
    const assoc = await hubspotFetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/calls?limit=100`,
    )
    if (!assoc.ok) return
    const ids = (((await assoc.json()) as { results?: { toObjectId?: string | number }[] }).results ?? [])
      .map((r) => String(r.toObjectId ?? ''))
      .filter(Boolean)
    if (ids.length === 0) return

    const batch = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/calls/batch/read', {
      method: 'POST',
      body: JSON.stringify({ properties: ['hs_call_body'], inputs: ids.map((id) => ({ id })) }),
    })
    if (!batch.ok) return
    const rows = ((await batch.json()) as { results?: { id: string; properties?: Record<string, string | null> }[] }).results ?? []
    const match = rows.find((r) => (r.properties?.hs_call_body ?? '').includes(`Twilio Call SID: ${callSid}`))
    if (!match) return

    const body = `${match.properties?.hs_call_body ?? ''}\n${line}`.trim()
    await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/calls/${match.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { hs_call_body: body } }),
    })
  } catch (error) {
    console.error('calls: could not annotate the call in HubSpot', error instanceof Error ? error.message : error)
  }
}

// ---------------------------------------------------------------------------
// The same merge, started from the contact rather than from a call.
//
// 220 of the 221 placeholder contacts in the portal have no call attached: the
// phone system has been creating them since May and only started logging calls
// on 15 September. So the backlog cannot be worked from the call list, and this
// is the door that clears it.
// ---------------------------------------------------------------------------
const LinkPlaceholderInput = z.object({
  placeholderId: z.string().regex(/^\d{1,20}$/, 'Not a HubSpot contact id'),
  contactId: z.string().regex(/^\d{1,20}$/, 'Not a HubSpot contact id'),
  contactEmail: z.string().trim().email().max(320),
  confirmExtra: z.boolean().optional(),
})

export async function linkPlaceholderToContact(input: unknown): Promise<CallActionResult<{ mergedInto: string }>> {
  const parsed = LinkPlaceholderInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { placeholderId, contactId, contactEmail, confirmExtra } = parsed.data

  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!auth.capabilities.has('calls.view') && !auth.capabilities.has('admin')) {
    return { success: false, error: 'You do not have access to calls.' }
  }
  if (placeholderId === contactId) {
    return { success: false, error: 'Those are the same contact.' }
  }

  // The record being merged away must BE a placeholder. Read it now rather than
  // trusting the id that came from the browser: this is the one check between a
  // mis-click and a real customer being merged into another one.
  const placeholder = await readContact(placeholderId)
  if (placeholder.notFound) return { success: false, error: 'That record has already gone. Reload the page.' }
  if (!placeholder.ok || !placeholder.contact) {
    return { success: false, error: placeholder.error ?? 'Could not read that record.' }
  }
  if (!isPlaceholderContact(placeholder.contact)) {
    return {
      success: false,
      error: 'That is not an Unknown Caller placeholder, so the Hub will not merge it away.',
    }
  }

  const target = await readContact(contactId)
  if (target.notFound) return { success: false, error: 'That contact no longer exists in HubSpot.' }
  if (!target.ok || !target.contact) return { success: false, error: target.error ?? 'Could not read that contact.' }
  if ((target.contact.email ?? '').trim().toLowerCase() !== contactEmail.toLowerCase()) {
    return { success: false, error: 'That contact changed while you were looking at it. Search again.' }
  }
  if (isPlaceholderContact(target.contact)) {
    return { success: false, error: 'That is another Unknown Caller record. Pick the contact with the email on it.' }
  }

  if (!confirmExtra) {
    const blast = await countAssociations(placeholderId)
    if (blast.calls > 1 || blast.deals > 0) {
      return {
        success: false,
        error: `This number carries ${blast.calls} calls and ${blast.deals} deals. Merging moves all of them onto ${contactEmail}.`,
        needsConfirmation: blast,
      }
    }
  }

  try {
    const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/contacts/merge', {
      method: 'POST',
      body: JSON.stringify({ primaryObjectId: contactId, objectIdToMerge: placeholderId }),
    })
    if (!response.ok) {
      const body = await response.text()
      console.error('calls: HubSpot refused the placeholder merge', {
        placeholderId,
        status: response.status,
        body: body.slice(0, 300),
      })
      return {
        success: false,
        error:
          response.status === 409
            ? 'HubSpot says these are already merged. Reload the page.'
            : 'HubSpot refused the merge. Merge the two contacts by hand in HubSpot.',
      }
    }
  } catch (error) {
    if (error instanceof HubSpotConfigError) return { success: false, error: error.message }
    console.error('calls: the placeholder merge threw', error instanceof Error ? error.message : error)
    return { success: false, error: 'HubSpot could not be reached. Nothing was changed.' }
  }

  // Any calls the Hub already holds against that placeholder now belong to the
  // survivor. There may be none, which is the normal case for the backlog.
  const admin = createAdminClient()
  const now = new Date().toISOString()
  const { error } = await admin
    .from('hub_calls')
    .update({
      hubspot_contact_id: contactId,
      linked_contact_id: contactId,
      merged_contact_id: placeholderId,
      link_state: 'linked',
      linked_by_uid: auth.user.id,
      linked_at: now,
      link_note: 'Linked from the placeholder list',
      updated_at: now,
    })
    .eq('hubspot_contact_id', placeholderId)
    .neq('link_state', 'linked')

  if (error) console.error('calls: merged, but could not relink the stored calls', error.message)

  revalidatePath('/calls')
  return { success: true, data: { mergedInto: contactId } }
}
