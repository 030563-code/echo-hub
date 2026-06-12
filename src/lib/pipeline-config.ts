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
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [],
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
  },
  {
    pipelineId: '2cfa0ec9-937b-44dc-9ee7-146d8745ab33',
    label: 'UK SALES - NEW',
    allowedDepots: [{ label: 'GB-BSE', value: 'GB-Bury St Edmunds' }],
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [],
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
  },
  {
    pipelineId: '14520121',
    label: 'AUSTRALIA SALES',
    allowedDepots: [{ label: 'AU-SYD', value: 'AU-Sydney' }],
    allowedTemplates: [{ label: 'Standard Quote Template', value: 'default' }],
    allowedDistributors: [],
  },
]
