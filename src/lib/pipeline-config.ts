/**
 * Region (HubSpot pipeline) catalogue — the row-scoping dimension for Quotes.
 * Ported from the sales-hub. A user's `profiles.pipeline_id` = their region; the
 * Quotes module's RLS shows a non-admin only the deals in their pipeline.
 *
 * `allowedDepots[].label` is the depot CODE (e.g. US-BAL) — the value the SKU
 * mapping, deals_registry, and the DB triggers all key on. `.value` is the human
 * display name.
 */

export interface PipelineConfig {
  pipelineId: string
  label: string
  allowedDepots: { label: string; value: string }[]
  allowedTemplates: { label: string; value: string }[]
  allowedDistributors: string[]
  /** Currencies a deal in this pipeline may be raised in. Constrains both the
   *  picker and the server-side check in createDeal. */
  allowedCurrencies: string[]
}

/**
 * Flag and name for each currency the picker can offer.
 *
 * Separate from allowedCurrencies so a pipeline can be given a currency
 * without anyone having to remember to add its display strings too: a missing
 * entry degrades to the bare ISO code, which is still unambiguous.
 */
export const CURRENCY_FLAG: Record<string, 'US' | 'CA'> = {
  USD: 'US',
  CAD: 'CA',
}

export const CURRENCY_NAME: Record<string, string> = {
  USD: 'US Dollar',
  CAD: 'Canadian Dollar',
  EUR: 'Euro',
  GBP: 'British Pound',
  AUD: 'Australian Dollar',
}

// HubSpot team ID → pipeline ID (for pre-suggesting a region on invite).
export const TEAM_PIPELINE_MAP: Record<string, string> = {
  '949190': 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc', // Echo Barrier USA sales → USA SALES
  '32677': 'd739df20-18b4-4e4b-b183-943038071da1', // Echo Barrier Europe → EURO SALES
  '570270': 'd739df20-18b4-4e4b-b183-943038071da1', // France → EURO SALES
  '592522': 'd739df20-18b4-4e4b-b183-943038071da1', // Spain → EURO SALES
  '57566': '2cfa0ec9-937b-44dc-9ee7-146d8745ab33', // Echo Barrier UK Sales → UK SALES NEW
  '33592': '6f942aab-15a9-4cdb-a684-53e78b36c424', // Echo Barrier Inter Sales → INTERNATIONAL SALES
  '57567': '14520121', // Echo Barrier Australia → AUSTRALIA SALES
}

export const PIPELINE_CONFIG: PipelineConfig[] = [
  {
    pipelineId: 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc',
    label: 'USA SALES',
    allowedDepots: [
      { label: 'US-BAL', value: 'US Baltimore' },
      { label: 'US-SBD', value: 'US California' },
      { label: 'CA-HAM', value: 'CA - Hamilton' },
    ],
    // Live profiles carry ['US','CAN']; this said ['default'], which
    // taxRegionForTemplate does not recognise, so re-running onboarding would
    // have silently stripped the US tax note and printed the Dublin group
    // address on every US quote.
    allowedTemplates: [
      { label: 'US Quote Template', value: 'US' },
      { label: 'Canada Quote Template', value: 'CAN' },
    ],
    allowedDistributors: [],
    // Verified against the portal: 85 CAD deals exist, some in USA SALES.
    allowedCurrencies: ['USD', 'CAD'],
  },
  {
    pipelineId: 'd739df20-18b4-4e4b-b183-943038071da1',
    label: 'EURO SALES',
    allowedDepots: [
      { label: 'EU-SK', value: 'EU-Slovakia' },
      { label: 'EU-FR', value: 'EU-France' },
      { label: 'GB-BSE', value: 'GB-Bury St Edmunds' },
    ],
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [
      'Inerco Acustica',
      'AL Akustik (Denmark)',
      'KEE S.R.L. (Italy)',
      'HNA (Israel)',
      'UNC (Cyprus)',
      'Berlex AB (Sweden)',
      'GEBU Tech AG (Switzerland)',
      'Brodrene Dahl AS (Norway)',
    ],
    // TODO confirm with Dean. Only the US list is verified against the portal.
    allowedCurrencies: ['EUR'],
  },
  {
    pipelineId: '2cfa0ec9-937b-44dc-9ee7-146d8745ab33',
    label: 'UK SALES - NEW',
    allowedDepots: [{ label: 'GB-BSE', value: 'GB-Bury St Edmunds' }],
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [],
    // TODO confirm with Dean. Only the US list is verified against the portal.
    allowedCurrencies: ['GBP'],
  },
  {
    pipelineId: '6f942aab-15a9-4cdb-a684-53e78b36c424',
    label: 'INTERNATIONAL SALES',
    allowedDepots: [
      { label: 'GB-BSE', value: 'GB-Bury St Edmunds' },
      { label: 'EU-SK', value: 'EU-Slovakia' },
    ],
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [
      'Envirotech (India)',
      'Aktio Pacific (Singapore)',
      'Itochu (Japan)',
      'Takamiya (Japan)',
    ],
    // TODO confirm with Dean. Only the US list is verified against the portal.
    allowedCurrencies: ['GBP'],
  },
  {
    pipelineId: '14520121',
    label: 'AUSTRALIA SALES',
    allowedDepots: [{ label: 'AU-SYD', value: 'AU-Sydney' }],
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [],
    // TODO confirm with Dean. Only the US list is verified against the portal.
    allowedCurrencies: ['AUD'],
  },
]

/** The currencies a pipeline may raise a deal in, falling back to USD for an
 *  unknown pipeline so a misconfigured profile cannot widen the allowlist. */
export function allowedCurrenciesForPipeline(pipelineId: string | null | undefined): string[] {
  return PIPELINE_CONFIG.find((p) => p.pipelineId === pipelineId)?.allowedCurrencies ?? ['USD']
}
