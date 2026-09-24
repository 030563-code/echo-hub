'use server'

/**
 * Find-or-create the draft customer invoice for an accepted deal. Building
 * snapshots the deal's line_items_raw (fitting-kit split applied), delivery
 * address and Xero account code; the invoice is then edited independently of
 * the deal, with drift surfaced via the source snapshot hash.
 *
 * Which organisation invoices the deal follows from its depot, and that
 * organisation's invoicing profile (currency, country, tax engine, Xero) drives
 * everything below. An organisation with no profile is refused with a sentence.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildDraftLines, type RawDealLine } from '@/lib/customer-invoice/build-draft'
import { fetchHubSpotLineDescriptions } from '@/lib/customer-invoice/line-descriptions'
import { isInvoiceDepot } from '@/lib/customer-invoice/constants'
import { depotCode } from '@/lib/depot-constants'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import { hasStateField } from '@/lib/delivery-address'
import { linesHash } from '@/lib/customer-invoice/hash'
import { holdsOrganisation, orgForDepot, orgLabel } from '@/lib/organisations'
import { xeroItemAccounts } from '@/lib/xero-hub'
import {
  requireInvoicingManage,
  lookupXeroItemCodes,
  getAcceptedAt,
  isAcceptedSinceCutover,
  isNotInvoiceableStage,
} from '@/app/actions/invoicing/shared'

const Input = z.object({
  dealId: z.string().regex(/^\d+$/),
  // Set by rebuildInvoiceFromDeal, whose reviewed flag must win over the deal's.
  // A fresh draft takes its answer from deals_registry.is_collection, given at
  // Quote Setup and confirmed at acceptance.
  isCollection: z.boolean().optional(),
})

export type OpenInvoiceResult =
  | { success: true; invoiceId: string; created: boolean }
  | { success: false; error: string }

export async function openInvoiceForDeal(input: {
  dealId: string
  isCollection?: boolean
}): Promise<OpenInvoiceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid deal id' }
  const { dealId } = parsed.data

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('customer_invoices')
    .select('id')
    .eq('hubspot_deal_id', dealId)
    .neq('status', 'voided')
    .maybeSingle()
  if (existing) return { success: true, invoiceId: existing.id, created: false }

  const { data: deal, error: dealError } = await admin
    .from('deals_registry')
    .select(
      'hubspot_deal_id, hubspot_company_id, deal_name, deal_status, depot_code, currency, line_items_raw, quote_reference, delivery_street, delivery_city, delivery_state, delivery_zip, is_collection',
    )
    .eq('hubspot_deal_id', dealId)
    .maybeSingle()
  if (dealError) return { success: false, error: 'Failed to load the deal from the registry.' }
  if (!deal) return { success: false, error: 'This deal has no registry row yet. It appears a minute or two after acceptance.' }

  // The rebuild's explicit flag wins: it carries what the REVIEWER decided on
  // the invoice being replaced, which is later information than the deal's.
  const isCollection = parsed.data.isCollection ?? deal.is_collection === true

  // Same rule as the queue, enforced here because this action is directly
  // POSTable: the deal must have ENTERED Quotation Accepted on or after the
  // cutover, and must not have ended up Closed Lost.
  //
  // The current stage is deliberately NOT required to still be Quotation
  // Accepted. Deals pass through it in minutes on their way to Closed Won, and
  // requiring it made them permanently un-invoiceable.
  if (isNotInvoiceableStage(deal.deal_status as string | null)) {
    return { success: false, error: 'This deal is Closed Lost, so it cannot be invoiced.' }
  }
  const acceptedAt = (await getAcceptedAt([dealId])).get(dealId)
  if (!isAcceptedSinceCutover(acceptedAt)) {
    return {
      success: false,
      error:
        'This deal has not been marked Quotation Accepted since the Hub invoicing cutover, so it cannot be invoiced here.',
    }
  }

  // The deal's depot says which organisation invoices it. That organisation
  // has to be one the caller holds, and has to have an invoicing profile: the
  // USA since September 2026, France since Dean's decision of 22 Sep 2026, and
  // Canada since 24 Sep 2026 up to the tax step. Each of the others is its own
  // follow-up, and until then the queue shows the deal and this is the answer.
  // Whichever spelling the sync wrote: the code, or HubSpot's internal value
  // for it ('EU-France' for EU-FR). A depot the Hub does not know is refused
  // by the name the record actually carries.
  const rawDepot = String(deal.depot_code ?? '').trim()
  const depot = depotCode(rawDepot)
  const org = orgForDepot(depot)
  if (!depot || !org) {
    return { success: false, error: `This deal's depot (${rawDepot || 'not set'}) belongs to no organisation the Hub knows, so it cannot be invoiced here.` }
  }
  if (!holdsOrganisation(gate.auth.profile.organisations, org)) {
    return { success: false, error: 'This deal belongs to an organisation you do not hold.' }
  }
  const profile = invoicingProfile(org)
  if (!profile) {
    return {
      success: false,
      error: `Invoicing for ${orgLabel(org)} is not set up in the Hub yet. The deal is listed for reference; its invoice has to be raised outside the Hub for now.`,
    }
  }
  // The organisation's depots are the profile's by definition; this is the
  // type's proof of it, and the refusal if the mapping and the profile ever
  // disagree.
  if (!isInvoiceDepot(depot) || !(profile.depots as readonly string[]).includes(depot)) {
    return {
      success: false,
      error: `${orgLabel(org)} invoicing handles ${profile.depots.join(' and ')} deals; this deal's depot is ${depot}.`,
    }
  }
  // The invoice is in the ORGANISATION's currency. Where the registry's
  // currency is trustworthy (the USA SALES sync writes it, for the USA and for
  // Canada) it is checked against that, because a deal priced in the other
  // country's currency is the mistake this exists to catch: invoicing it would
  // print the quote's numbers under the wrong currency. France is not held to
  // it: n8n's EURO sync never wrote the column, so all 63 French deals carry
  // 'USD', the column default, and refusing on that would refuse every French
  // invoice for a value nobody chose.
  const registryCurrency = String(deal.currency ?? '').trim().toUpperCase()
  if (profile.checksRegistryCurrency && registryCurrency && registryCurrency !== profile.currency) {
    return {
      success: false,
      error:
        org === 'EB-USA'
          ? `This deal is in ${registryCurrency}. US invoicing is USD only, because the TaxJar and Xero ` +
            `flow behind it is a US sales-tax flow. Invoice a ${registryCurrency} deal through the Canadian ` +
            `process instead, or correct the deal's currency in HubSpot if ${registryCurrency} is wrong.`
          : `This deal is in ${registryCurrency}, and ${orgLabel(org)} invoices in ${profile.currency} only. ` +
            `Correct the deal's currency in HubSpot if ${registryCurrency} is wrong, or give the deal the ` +
            `depot of the organisation that sells in ${registryCurrency}.`,
    }
  }
  const currency = profile.currency

  // The Xero account number for this customer in THIS organisation's Xero. It
  // doubles as the TaxJar customer id for the USA, hence the column name it is
  // stored under.
  let companyName: string | null = null
  let xeroAccountCode: string | null = null
  const companyIdClean = String(deal.hubspot_company_id ?? '').replace(/\D/g, '')
  if (companyIdClean) {
    const { data: account } = await admin
      .from('account_registry')
      .select(`hubspot_company_name, ${profile.accountCodeColumn}`)
      .eq('hubspot_company_id', Number(companyIdClean))
      .maybeSingle()
    const row = (account ?? null) as Record<string, string | null> | null
    companyName = row?.hubspot_company_name ?? null
    // `?? null` is not enough: account_registry holds 15,335 EMPTY STRINGS
    // against only 48 real codes, so `is not null` lies. Coerce blanks to null
    // here or the invoice stores '' and every "has an account code?" check
    // downstream has to remember to be falsy rather than null-checked.
    xeroAccountCode = row?.[profile.accountCodeColumn]?.trim() || null
  }

  const rawLines = (Array.isArray(deal.line_items_raw) ? deal.line_items_raw : []) as RawDealLine[]
  const lines = buildDraftLines(rawLines, depot)

  // The description the customer read on the quote. The sync that writes
  // line_items_raw never asked HubSpot for it, so every invoice line arrived
  // blank even though HubSpot had the text all along. Read here rather than
  // waiting on a change to the sync, so the deals already in the registry are
  // fixed too. buildDraftLines has already fallen back to the Xero item
  // description where the raw line carried one, and HubSpot wins over that
  // because it is what the customer was actually sent.
  const descriptions = await fetchHubSpotLineDescriptions(
    lines.map((l) => l.hs_line_item_id ?? '').filter((id) => id !== ''),
  )
  for (const line of lines) {
    // A kit split writes its own description ("Fitting kit x 3 ..."), which
    // explains a line the customer's quote does not have. Never overwrite it.
    if (line.origin === 'kit_split') continue
    const found = line.hs_line_item_id ? descriptions.get(line.hs_line_item_id) : undefined
    if (found) line.description = found
  }

  // Resolve Xero item codes for each line's own ship-from depot.
  const codes = await lookupXeroItemCodes(lines.map((l) => ({ sku: l.sku, depot: l.ship_from_depot })))
  for (const line of lines) {
    if (line.sku) {
      const mapped = codes.get(`${line.sku}|${line.ship_from_depot}`)
      if (mapped) line.xero_item_code = mapped
    }
  }

  // Prefill the Xero sales account per line. The account belongs to the Xero
  // ITEM and genuinely varies per product (H9 07-4008, H10 07-4014, H9X
  // 07-4015, hooks and bungees 07-4080, freight 07-4150), so it is read from
  // Xero rather than derived from a rule here. It stays editable in the editor.
  //
  // A failure is deliberately not fatal: the column simply stays empty, which
  // is exactly how it behaved before, and drafting must not depend on Xero
  // being reachable.
  const accounts = await xeroItemAccounts(org)
  if (accounts.ok) {
    for (const line of lines) {
      const account = line.xero_item_code ? accounts.data[line.xero_item_code] : null
      if (account) line.account_code = account
    }
  }

  // A French address has no state, and the database refuses one on a French
  // row. Whatever the registry holds there is not carried over. A US state and
  // a Canadian province both are.
  const deliveryState = hasStateField(profile.country) ? (deal.delivery_state ?? null) : null

  const header = {
    hubspot_deal_id: dealId,
    organisation_code: org,
    currency,
    holding_prefix: profile.holdingPrefix,
    hubspot_company_id: companyIdClean || null,
    company_name: companyName ?? deal.deal_name ?? null,
    taxjar_customer_id: xeroAccountCode,
    delivery_street: deal.delivery_street ?? null,
    delivery_city: deal.delivery_city ?? null,
    delivery_state: deliveryState,
    delivery_zip: deal.delivery_zip ?? null,
    delivery_country: profile.country,
    is_collection: isCollection,
    subtotal: lines.filter((l) => !l.is_shipping).reduce((acc, l) => acc + l.line_total, 0),
    shipping_total: lines.filter((l) => l.is_shipping).reduce((acc, l) => acc + l.line_total, 0),
    source_lines_snapshot: rawLines,
    lines_hash: linesHash(lines, {
      delivery_street: deal.delivery_street ?? null,
      delivery_city: deal.delivery_city ?? null,
      delivery_state: deliveryState,
      delivery_zip: deal.delivery_zip ?? null,
      taxjar_customer_id: xeroAccountCode,
      is_collection: isCollection,
    }),
    created_by_uid: gate.auth.user.id,
  }

  const { data: created, error: createError } = await admin.rpc('create_customer_invoice', {
    p_header: header,
    p_lines: lines,
  })

  if (createError) {
    // Unique violation on the active-per-deal index = a concurrent open; the
    // invoice exists now, so hand it back instead of failing.
    if (createError.code === '23505' || /duplicate key/i.test(createError.message ?? '')) {
      const { data: raced } = await admin
        .from('customer_invoices')
        .select('id')
        .eq('hubspot_deal_id', dealId)
        .neq('status', 'voided')
        .maybeSingle()
      if (raced) return { success: true, invoiceId: raced.id, created: false }
    }
    return { success: false, error: 'Could not create the draft invoice.' }
  }

  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  return { success: true, invoiceId: (created as { id: string }).id, created: true }
}
