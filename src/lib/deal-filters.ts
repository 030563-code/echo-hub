/**
 * The filter state shared by the deals board and the All tab, and its
 * translation into HubSpot search filters.
 *
 * Dean asked for "a filter and advanced filter similar to hubspots filter on
 * top just dumbed down to every parameter we can filter to". This is the first
 * pass: the deal's own properties, which the search call can narrow on before
 * any cap applies.
 *
 * WHY THIS IS SERVER-SIDE, and it matters more than it looks. Both surfaces are
 * capped: the board fetches a 60-day, 400-deal window and the All tab pages 25
 * at a time. A filter applied to the rows already on screen would answer "no
 * such deal" whenever the deal simply sat outside that window, which is a
 * filter that lies. Every filter here becomes a HubSpot filter entry instead,
 * so HubSpot narrows first and the cap applies to the narrowed set.
 *
 * Associated company and contact are deliberately NOT here. HubSpot's Search
 * API does not return associations (see the note in getDealDetails and
 * searchContact), so those need a separate batch association read and are a
 * second pass.
 */

/** One entry in a HubSpot search filterGroup. `values` is the IN form. */
export interface HubSpotSearchFilter {
  propertyName: string
  operator: string
  value?: string
  values?: string[]
}

export interface DealFilters {
  /** Substring of the deal name. */
  q: string
  /**
   * A HubSpot pipeline id. Used by the All tab, which spans pipelines and
   * needs one chosen before its stage list means anything. The board strips
   * this: it pins its own pipeline, and a second EQ on a different one would
   * empty the board rather than be ignored.
   */
  pipelineId: string
  /** HubSpot stage ids. Empty means every stage. */
  stages: string[]
  /** A HubSpot owner id. Only ever offered to an admin viewing all reps. */
  ownerId: string
  /**
   * The depot as HubSpot STORES it in `sending_depot`, which is the long name
   * ("US Baltimore"), not the code. That property is an enumeration whose
   * internal value is the long name and whose display label is the code, the
   * inverse of DEPOT_MAPPING's naming. Verified against the live property on
   * 2026-09-03, where filtering on "US-SBD" matches nothing and "US California"
   * matches.
   */
  depot: string
  amountMin: string
  amountMax: string
  /** yyyy-mm-dd, inclusive at both ends. */
  createdFrom: string
  createdTo: string
}

export const EMPTY_DEAL_FILTERS: DealFilters = {
  q: '',
  pipelineId: '',
  stages: [],
  ownerId: '',
  depot: '',
  amountMin: '',
  amountMax: '',
  createdFrom: '',
  createdTo: '',
}

/** The URL parameter name for each field, so the bar, the links and the
 *  parser cannot drift apart. */
export const DEAL_FILTER_PARAMS = {
  q: 'q',
  pipelineId: 'pipeline',
  stages: 'stages',
  ownerId: 'owner',
  depot: 'depot',
  amountMin: 'amountMin',
  amountMax: 'amountMax',
  createdFrom: 'createdFrom',
  createdTo: 'createdTo',
} as const

type RawParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? '').trim()
  return String(value ?? '').trim()
}

/**
 * Read the filters out of a Next.js searchParams object.
 *
 * Stages arrive either repeated or comma-joined depending on how the form
 * serialised, so both are accepted rather than trusting one shape.
 */
export function parseDealFilters(params: RawParams): DealFilters {
  const rawStages = params[DEAL_FILTER_PARAMS.stages]
  const stages = (Array.isArray(rawStages) ? rawStages : String(rawStages ?? '').split(','))
    .map((s) => String(s).trim())
    .filter((s) => s !== '')

  return {
    q: one(params[DEAL_FILTER_PARAMS.q]),
    pipelineId: one(params[DEAL_FILTER_PARAMS.pipelineId]),
    stages,
    ownerId: one(params[DEAL_FILTER_PARAMS.ownerId]),
    depot: one(params[DEAL_FILTER_PARAMS.depot]),
    amountMin: one(params[DEAL_FILTER_PARAMS.amountMin]),
    amountMax: one(params[DEAL_FILTER_PARAMS.amountMax]),
    createdFrom: one(params[DEAL_FILTER_PARAMS.createdFrom]),
    createdTo: one(params[DEAL_FILTER_PARAMS.createdTo]),
  }
}

/**
 * The deals board's filters: everything parseDealFilters reads, except that
 * `pipelineId` is always blank.
 *
 * The board has its OWN pipeline selector, and it uses the same `pipeline`
 * parameter this module names in DEAL_FILTER_PARAMS. Treating it as a filter as
 * well puts two fields of that name into one form, so submitting sends the
 * parameter twice, it arrives as an array rather than a string, and the board
 * falls back to the viewer's profile pipeline. The visible symptom is choosing
 * USA SALES and being bounced to whatever region the profile carries.
 *
 * getDealsForBoard strips the same field server-side. This is the other half,
 * so the parameter never reaches the markup in the first place.
 */
export function parseBoardDealFilters(params: RawParams): DealFilters {
  return { ...parseDealFilters(params), pipelineId: '' }
}

/**
 * yyyy-mm-dd to epoch milliseconds, which is the form HubSpot date filters
 * take and what the board's own window filter already sends.
 *
 * `endOfDay` makes an upper bound cover the whole day the user picked. Without
 * it, "created to 3 September" silently excludes everything created on the
 * third, which reads as missing data rather than as an off-by-one.
 */
function epochFromISODate(value: string, endOfDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`)
  return Number.isNaN(ms) ? null : String(ms)
}

function numeric(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? String(parsed) : null
}

/**
 * Translate the filter state into HubSpot search filters.
 *
 * A blank or unparseable field contributes NOTHING. HubSpot rejects a filter
 * carrying an empty value, so one stray blank would fail the whole board
 * rather than widen it.
 */
export function dealFiltersToHubSpot(filters: DealFilters): HubSpotSearchFilter[] {
  const out: HubSpotSearchFilter[] = []

  const q = filters.q.trim()
  if (q !== '') {
    // CONTAINS_TOKEN matches whole tokens, so a bare "acme" does not match
    // "Acme Corporation" typed halfway. The trailing wildcard is what makes it
    // behave like the substring search a rep expects from a search box.
    out.push({
      propertyName: 'dealname',
      operator: 'CONTAINS_TOKEN',
      value: q.endsWith('*') ? q : `${q}*`,
    })
  }

  if (filters.pipelineId !== '') {
    out.push({ propertyName: 'pipeline', operator: 'EQ', value: filters.pipelineId })
  }

  if (filters.stages.length > 0) {
    out.push({ propertyName: 'dealstage', operator: 'IN', values: [...filters.stages] })
  }

  if (filters.ownerId !== '') {
    out.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: filters.ownerId })
  }

  if (filters.depot !== '') {
    out.push({ propertyName: 'sending_depot', operator: 'EQ', value: filters.depot })
  }

  const min = numeric(filters.amountMin)
  if (min !== null) out.push({ propertyName: 'amount', operator: 'GTE', value: min })

  const max = numeric(filters.amountMax)
  if (max !== null) out.push({ propertyName: 'amount', operator: 'LTE', value: max })

  const from = epochFromISODate(filters.createdFrom)
  if (from !== null) out.push({ propertyName: 'createdate', operator: 'GTE', value: from })

  const to = epochFromISODate(filters.createdTo, true)
  if (to !== null) out.push({ propertyName: 'createdate', operator: 'LTE', value: to })

  return out
}

/** How many filters the user has actually set, for the "Filters (3)" badge. */
export function activeDealFilterCount(filters: DealFilters): number {
  let count = 0
  if (filters.q.trim() !== '') count++
  if (filters.pipelineId !== '') count++
  if (filters.stages.length > 0) count++
  if (filters.ownerId !== '') count++
  if (filters.depot !== '') count++
  if (filters.amountMin.trim() !== '') count++
  if (filters.amountMax.trim() !== '') count++
  if (filters.createdFrom.trim() !== '') count++
  if (filters.createdTo.trim() !== '') count++
  return count
}

/**
 * The filters as URL parameters, omitting every empty one so a shared link
 * carries only what was set.
 */
export function dealFiltersToQuery(filters: DealFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (filters.q.trim() !== '') out[DEAL_FILTER_PARAMS.q] = filters.q.trim()
  if (filters.pipelineId !== '') out[DEAL_FILTER_PARAMS.pipelineId] = filters.pipelineId
  if (filters.stages.length > 0) out[DEAL_FILTER_PARAMS.stages] = filters.stages.join(',')
  if (filters.ownerId !== '') out[DEAL_FILTER_PARAMS.ownerId] = filters.ownerId
  if (filters.depot !== '') out[DEAL_FILTER_PARAMS.depot] = filters.depot
  if (filters.amountMin.trim() !== '') out[DEAL_FILTER_PARAMS.amountMin] = filters.amountMin.trim()
  if (filters.amountMax.trim() !== '') out[DEAL_FILTER_PARAMS.amountMax] = filters.amountMax.trim()
  if (filters.createdFrom.trim() !== '') out[DEAL_FILTER_PARAMS.createdFrom] = filters.createdFrom.trim()
  if (filters.createdTo.trim() !== '') out[DEAL_FILTER_PARAMS.createdTo] = filters.createdTo.trim()
  return out
}
