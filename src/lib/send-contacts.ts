import 'server-only'

/**
 * The address book behind a send.
 *
 * Dean, 17 Sep 2026: "Maybe a tick box that already have these in for him and the ability to add
 * more to a library in supabase that adds to the tickbox", forwarding what Operations actually
 * does: seven addresses on every Bamida purchase order, and a forwarder contact that depends on
 * whether the shipment goes by sea or by air.
 *
 * 🔴 REQUIRED IS NOT SELECTED. A required contact is merged into the recipients on the server
 * whatever arrives from the browser, so nothing a caller sends can drop the manufacturer's own
 * desk or the four people Dean named. A selected contact merely starts ticked.
 *
 * That is the difference between this and a default: a default is a suggestion the client can
 * override, and every export of a 'use server' file is a public endpoint.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type SendChannel = 'manufacturing' | 'cargo'

export interface SendContact {
  id: string
  address: string
  displayName: string | null
  organisation: string | null
  field: 'to' | 'cc'
  /** Cargo only. Empty means every transport mode. */
  modalities: string[]
  defaultSelected: boolean
  isRequired: boolean
}

const COLUMNS =
  'id, address, display_name, organisation, field, modalities, default_selected, is_required, sort_order'

type Row = {
  id: string
  address: string
  display_name: string | null
  organisation: string | null
  field: string
  modalities: string[] | null
  default_selected: boolean
  is_required: boolean
}

const toContact = (r: Row): SendContact => ({
  id: r.id,
  address: r.address,
  displayName: r.display_name,
  organisation: r.organisation,
  field: r.field === 'to' ? 'to' : 'cc',
  modalities: r.modalities ?? [],
  defaultSelected: r.default_selected,
  isRequired: r.is_required,
})

/**
 * Every active contact for a channel, in display order.
 *
 * `modality` filters the cargo book: a contact with no modalities applies to every mode, and one
 * with modalities applies only when the shipment matches. Sea and air are different people at the
 * forwarder, which is exactly why this is not one list.
 *
 * Returns an EMPTY list on a failed read rather than throwing. The caller merges the required
 * contacts from the same source, so an empty book means the send refuses for want of a recipient,
 * which is the safe way to fail.
 */
export async function loadSendContacts(
  channel: SendChannel,
  modality?: string | null,
): Promise<SendContact[]> {
  const { data, error } = await createAdminClient()
    .from('send_contact')
    .select(COLUMNS)
    .eq('channel', channel)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('address', { ascending: true })

  if (error || !data) return []
  const all = (data as unknown as Row[]).map(toContact)
  if (!modality) return all
  return all.filter((c) => c.modalities.length === 0 || c.modalities.includes(modality))
}

/**
 * Turn the book plus whatever the browser ticked into the two address lines that are actually sent.
 *
 * The rules, in order, and the order is the point:
 *   1. Every REQUIRED contact goes in, whether or not it was ticked.
 *   2. Every contact whose id was ticked goes in.
 *   3. Anything typed into the free-text boxes is added on top.
 * Nothing removes an address. The first spelling of each wins, ignoring case, so ticking somebody
 * who is also required cannot produce a second copy.
 */
export function resolveSelection(
  contacts: readonly SendContact[],
  selectedIds: readonly string[],
  typed: { to?: string | null; cc?: string | null },
): { to: string; cc: string; used: SendContact[] } {
  const ticked = new Set(selectedIds)
  const used = contacts.filter((c) => c.isRequired || ticked.has(c.id))

  const join = (field: 'to' | 'cc', extra: string | null | undefined) => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (address: string) => {
      const clean = address.trim()
      if (!clean) return
      const key = clean.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push(clean)
    }
    for (const c of used) if (c.field === field) push(c.address)
    for (const piece of String(extra ?? '').split(',')) push(piece)
    return out.join(', ')
  }

  return { to: join('to', typed.to), cc: join('cc', typed.cc), used }
}

/**
 * How the factory signs in: the address the login is under, and the password if one is configured.
 *
 * 🔴 Dean, 17 Sep 2026: "better to include the password in that email everytime I will inject it as
 * a netlify variable called BAMIDA_PASSWORD". I argued against emailing it and he has decided,
 * twice. What is worth writing down is the consequence rather than the argument: the order email
 * goes to ten people, and from here anybody holding one of those emails, or forwarded one, can sign
 * in as the factory. The password does not expire, so that stays true until it is changed.
 *
 * Two things keep it as small as it can be. It is only included when the variable is SET, so
 * removing it from Netlify turns this off with no deploy. And the login it exposes is an external
 * account that can read its own stock feed and its own orders and nothing else, which was proved
 * when the account was made.
 *
 * The address is the book's required `to` contact rather than a second setting, so the login
 * printed in the email can never drift from the desk the email is addressed to.
 */
export function factoryLogin(contacts: readonly SendContact[]): { email: string; password: string } | null {
  const password = String(process.env.BAMIDA_PASSWORD ?? '').trim()
  if (!password) return null
  const email = contacts.find((c) => c.field === 'to' && c.isRequired)?.address
  if (!email) return null
  return { email, password }
}

/**
 * Add a contact to the book, or bring a retired one back.
 *
 * Never required and never pre-ticked: a row added from a send screen is somebody's answer to one
 * order, and making it required from there would let one person quietly put themselves on every
 * order the Hub ever sends.
 */
export async function addSendContact(input: {
  channel: SendChannel
  address: string
  displayName: string | null
  organisation: string | null
  field: 'to' | 'cc'
  actorUid: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const address = input.address.trim()
  // Deliberately loose. The mail server is the real authority on an address, and a regex that
  // thinks it knows better rejects valid ones.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return { ok: false, error: 'That does not look like an email address.' }
  }

  const admin = createAdminClient()

  // 🔴 Look first, then write. The unique index is on (channel, lower(address)), and PostgREST's
  // on_conflict needs a constraint it can name, which a functional index is not. An upsert here
  // would fail on the second person to add the same address in different case.
  const { data: existing } = await admin
    .from('send_contact')
    .select('id')
    .eq('channel', input.channel)
    .ilike('address', address)
    .maybeSingle<{ id: string }>()

  if (existing) {
    // Already known. Bring it back if somebody had retired it, and leave everything else alone:
    // whoever set it up chose those values.
    const { error } = await admin
      .from('send_contact')
      .update({ is_active: true })
      .eq('id', existing.id)
    if (error) return { ok: false, error: 'That contact could not be saved.' }
    return { ok: true, id: existing.id }
  }

  const { data, error } = await admin
    .from('send_contact')
    .insert({
      channel: input.channel,
      address,
      display_name: input.displayName?.trim() || null,
      organisation: input.organisation?.trim() || null,
      field: input.field,
      default_selected: false,
      is_required: false,
      is_active: true,
      sort_order: 200,
      created_by_uid: input.actorUid,
    })
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error || !data) return { ok: false, error: 'That contact could not be saved.' }
  return { ok: true, id: data.id }
}
