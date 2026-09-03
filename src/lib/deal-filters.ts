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

/** One entry in a HubSpot search filterGroup. `values` is the IN form,
 *  `highValue` the upper bound of a BETWEEN. */
export interface HubSpotSearchFilter {
  propertyName: string
  operator: string
  value?: string
  /** readonly so a frozen constant list, such as a stage family, can be passed
   *  straight through without being copied. */
  values?: readonly string[]
  highValue?: string
}

/**
 * HubSpot's hard cap on one filterGroup, verified live on 2026-09-03: a
 * seventh filter returns 400 VALIDATION_ERROR, "too many filters per filter
 * group (count: 7, max allowed: 6)".
 *
 * Groups are OR'd, not AND'd, so a longer AND cannot be split across groups.
 * Six really is the ceiling for one narrowed search, which is why the two
 * range fields collapse into BETWEEN below and why buildDealFilterGroup
 * refuses in words rather than letting HubSpot refuse in a 400.
 */
export const HUBSPOT_MAX_FILTERS_PER_GROUP = 6

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
  /**
   * Free text the rep typed for the associated company, matched against the
   * company's name and domain. Not a HubSpot id: the rep types "Sunbelt", and
   * a resolver turns that into the ids the search filters on. This portal
   * duplicates company records per owner, so one typed name legitimately maps
   * to several ids, which is why the filter is an IN rather than an EQ.
   */
  company: string
  /** Free text for the associated contact, matched against email, first name
   *  and last name. Resolved to ids the same way as `company`. */
  contact: string
}

/**
 * The pseudo-properties the deal search accepts for associations. Both are
 * SINGULAR: 'associations.companies' returns a 400 whose message is only
 * "There was a problem with the request.", so a typo here fails loudly but
 * says nothing useful. Pinned in a constant and asserted in the tests.
 *
 * Verified live on 2026-09-03: EQ and IN both work, and an id that matches
 * nothing returns total 0 rather than an error.
 */
export const ASSOCIATION_FILTER_PROPERTIES = {
  company: 'associations.company',
  contact: 'associations.contact',
} as const

/** HubSpot's cap on one IN list, verified live: 120 values returns 400,
 *  "too many IN list values (count: 120, max allowed: 100)". */
export const HUBSPOT_MAX_IN_VALUES = 100

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
  company: '',
  contact: '',
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
  company: 'company',
  contact: 'contact',
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
    company: one(params[DEAL_FILTER_PARAMS.company]),
    contact: one(params[DEAL_FILTER_PARAMS.contact]),
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
 * The filters for a stage-scoped queue: Deals, Sent, Accepted, Won.
 *
 * Same as parseDealFilters except that `stages` is always empty. Each of those
 * tabs IS a stage filter already: getDealsByStage pins `dealstage IN <family>`
 * for its category. A second stage filter carried over from the board would AND
 * with that family, and any stage outside it empties the tab. Pipeline, depot,
 * name, owner, amount and dates all still apply, because none of them collide.
 */
export function parseStageQueueDealFilters(params: RawParams): DealFilters {
  return { ...parseDealFilters(params), stages: [] }
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
 * One translated filter, carrying the words to name it back to the rep.
 *
 * The label rides with the filter deliberately. buildDealFilterGroup has to
 * tell a rep which filters to clear when they set more than HubSpot accepts,
 * and a second hand-maintained list of names would drift from this one the
 * first time a field was added.
 */
interface TranslatedFilter {
  filter: HubSpotSearchFilter
  label: string
}

/**
 * The single translation, from which both the filter list and the labels come.
 *
 * A blank or unparseable field contributes NOTHING. HubSpot rejects a filter
 * carrying an empty value, so one stray blank would fail the whole board
 * rather than widen it.
 *
 * Both ranges collapse to a single BETWEEN when the rep sets both ends, which
 * is what keeps a fully-filtered view inside HUBSPOT_MAX_FILTERS_PER_GROUP.
 * BETWEEN was verified live on 2026-09-03 to be inclusive at both ends on
 * `amount` and on epoch-millisecond `createdate`, so it matches exactly what
 * the GTE plus LTE pair it replaces used to match.
 */
function translateDealFilters(filters: DealFilters): TranslatedFilter[] {
  const out: TranslatedFilter[] = []

  const q = filters.q.trim()
  if (q !== '') {
    // CONTAINS_TOKEN matches whole tokens, so a bare "acme" does not match
    // "Acme Corporation" typed halfway. The trailing wildcard is what makes it
    // behave like the substring search a rep expects from a search box.
    out.push({
      filter: {
        propertyName: 'dealname',
        operator: 'CONTAINS_TOKEN',
        value: q.endsWith('*') ? q : `${q}*`,
      },
      label: 'deal name',
    })
  }

  if (filters.pipelineId !== '') {
    out.push({
      filter: { propertyName: 'pipeline', operator: 'EQ', value: filters.pipelineId },
      label: 'pipeline',
    })
  }

  if (filters.stages.length > 0) {
    out.push({
      filter: { propertyName: 'dealstage', operator: 'IN', values: [...filters.stages] },
      label: 'stage',
    })
  }

  if (filters.ownerId !== '') {
    out.push({
      filter: { propertyName: 'hubspot_owner_id', operator: 'EQ', value: filters.ownerId },
      label: 'owner',
    })
  }

  if (filters.depot !== '') {
    out.push({
      filter: { propertyName: 'sending_depot', operator: 'EQ', value: filters.depot },
      label: 'depot',
    })
  }

  const min = numeric(filters.amountMin)
  const max = numeric(filters.amountMax)
  if (min !== null && max !== null) {
    out.push({
      filter: { propertyName: 'amount', operator: 'BETWEEN', value: min, highValue: max },
      label: 'amount',
    })
  } else if (min !== null) {
    out.push({ filter: { propertyName: 'amount', operator: 'GTE', value: min }, label: 'amount' })
  } else if (max !== null) {
    out.push({ filter: { propertyName: 'amount', operator: 'LTE', value: max }, label: 'amount' })
  }

  const from = epochFromISODate(filters.createdFrom)
  const to = epochFromISODate(filters.createdTo, true)
  if (from !== null && to !== null) {
    out.push({
      filter: { propertyName: 'createdate', operator: 'BETWEEN', value: from, highValue: to },
      label: 'created date',
    })
  } else if (from !== null) {
    out.push({ filter: { propertyName: 'createdate', operator: 'GTE', value: from }, label: 'created date' })
  } else if (to !== null) {
    out.push({ filter: { propertyName: 'createdate', operator: 'LTE', value: to }, label: 'created date' })
  }

  return out
}

/** Translate the filter state into HubSpot search filters. */
export function dealFiltersToHubSpot(filters: DealFilters): HubSpotSearchFilter[] {
  return translateDealFilters(filters).map((t) => t.filter)
}

export type DealFilterGroupResult =
  | { ok: true; filters: HubSpotSearchFilter[] }
  | { ok: false; error: string }

/**
 * The rep's filters plus whatever the caller pins server-side, refused in
 * words if the pair exceeds what HubSpot will accept in one group.
 *
 * Every deal surface pins something: the board pins its pipeline and its
 * 60-day window, the stage queues pin `dealstage IN <family>`, and any
 * non-admin has their owner pinned on all of them. Those come out of the same
 * budget of six as the rep's own filters, so how many filters a rep may set
 * depends on which page they are on. Before this existed the seventh filter
 * reached HubSpot, came back 400, and surfaced as "Failed to fetch deals from
 * HubSpot", which reads as an outage rather than as something the rep can fix.
 *
 * Both callers go through here so the two cannot disagree about the budget.
 */
/**
 * Company and contact ids already resolved from the free text the rep typed.
 *
 * The resolution is a HubSpot search, so it cannot happen in this pure module.
 * The caller resolves first and passes the ids in, which keeps the translation
 * testable and keeps the network call where the other network calls live.
 *
 * An EMPTY array is not the same as an absent one. Absent means the rep left
 * the box blank; empty means they typed a name that matches no company, and
 * the caller must return no deals rather than dropping the filter, or the
 * filter lies in exactly the way the note at the top of this file warns about.
 * Callers short-circuit on that case before reaching here.
 */
export interface ResolvedAssociationIds {
  companyIds?: readonly string[]
  contactIds?: readonly string[]
}

export function buildDealFilterGroup(
  fixed: HubSpotSearchFilter[],
  filters: DealFilters,
  resolved: ResolvedAssociationIds = {},
): DealFilterGroupResult {
  const translated = translateDealFilters(filters)

  // One IN entry per association, however many ids it holds, so filtering to a
  // company that this portal keeps as four duplicate records still costs one
  // filter out of the six.
  if (resolved.companyIds && resolved.companyIds.length > 0) {
    translated.push({
      filter: {
        propertyName: ASSOCIATION_FILTER_PROPERTIES.company,
        operator: 'IN',
        values: resolved.companyIds,
      },
      label: 'company',
    })
  }
  if (resolved.contactIds && resolved.contactIds.length > 0) {
    translated.push({
      filter: {
        propertyName: ASSOCIATION_FILTER_PROPERTIES.contact,
        operator: 'IN',
        values: resolved.contactIds,
      },
      label: 'contact',
    })
  }

  const total = fixed.length + translated.length

  if (total <= HUBSPOT_MAX_FILTERS_PER_GROUP) {
    return { ok: true, filters: [...fixed, ...translated.map((t) => t.filter)] }
  }

  const excess = total - HUBSPOT_MAX_FILTERS_PER_GROUP
  const labels = translated.map((t) => t.label)
  return {
    ok: false,
    error:
      `This view can apply ${HUBSPOT_MAX_FILTERS_PER_GROUP} filters at once and it is trying to apply ${total}. ` +
      `Clear ${excess} of: ${labels.join(', ')}.`,
  }
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
  if (filters.company.trim() !== '') count++
  if (filters.contact.trim() !== '') count++
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
  if (filters.company.trim() !== '') out[DEAL_FILTER_PARAMS.company] = filters.company.trim()
  if (filters.contact.trim() !== '') out[DEAL_FILTER_PARAMS.contact] = filters.contact.trim()
  return out
}
