/**
 * What the three-step create-deal wizard remembers between visits.
 *
 * Stores the CHOICES, never the lists they were chosen from: the company search
 * results and the paged contact list are refetched on the way back in, because
 * they are HubSpot's data and may have moved on, and because a page of contacts
 * is far bigger than the one contact that was picked.
 */

import { z } from 'zod'

const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().optional(),
  source: z.enum(['hubspot', 'supabase']),
})

const contactSchema = z.object({
  id: z.string(),
  properties: z.object({
    firstname: z.string(),
    lastname: z.string(),
    email: z.string(),
    phone: z.string().optional(),
    jobtitle: z.string().optional(),
  }),
})

export const dealWizardDraftSchema = z.object({
  v: z.literal(1),
  step: z.number().int().min(1).max(3),
  companyName: z.string(),
  selectedCompany: companySchema.nullable(),
  contactName: z.string(),
  contactEmail: z.string(),
  selectedContact: contactSchema.nullable(),
  dealName: z.string(),
  description: z.string(),
  currency: z.string(),
})

export type DealWizardDraft = z.infer<typeof dealWizardDraftSchema>

export const DEAL_WIZARD_KEY = 'deal-wizard'

export function parseDealWizardDraft(raw: unknown): DealWizardDraft | null {
  const parsed = dealWizardDraftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The wizard as it opens. A draft still equal to this is not worth resuming,
 *  so no row is kept for merely visiting the page. */
export function emptyDealWizardDraft(defaultCurrency: string): DealWizardDraft {
  return {
    v: 1,
    step: 1,
    companyName: '',
    selectedCompany: null,
    contactName: '',
    contactEmail: '',
    selectedContact: null,
    dealName: '',
    description: '',
    currency: defaultCurrency,
  }
}
