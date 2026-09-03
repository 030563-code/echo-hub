import Link from 'next/link'
import { DEPOT_MAPPING } from '@/lib/depot-constants'
import { DEAL_FILTER_PARAMS, activeDealFilterCount, type DealFilters } from '@/lib/deal-filters'

/**
 * The filter bar shared by the deals board and the All tab.
 *
 * A plain GET form, deliberately, not a client component. The filters decide
 * what the SERVER fetches, so they belong in the URL: a filtered view is then
 * linkable, survives paging and a refresh, and works with no JavaScript. It is
 * the same reasoning the scope toggle on both pages already follows.
 *
 * Paging parameters are NOT carried through as hidden inputs. Submitting drops
 * them, which resets to page one. Keeping a cursor across a filter change would
 * page into the middle of a result set that no longer exists.
 */

export interface StageOption {
  id: string
  label: string
}

export interface PipelineOption {
  id: string
  label: string
}

const FIELD = 'rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900'
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

export function DealFilterBar({
  action,
  filters,
  hidden = {},
  stages = [],
  pipelines = [],
  ownerNameById,
  showOwner = false,
}: {
  /** Where the form submits, e.g. '/quotes/board'. */
  action: string
  filters: DealFilters
  /** Parameters to preserve across a submit, such as scope and pipeline. */
  hidden?: Record<string, string>
  stages?: StageOption[]
  /** Offered only where the surface spans pipelines. The board pins its own,
   *  so it passes none. */
  pipelines?: PipelineOption[]
  /** Owner id to display name, for the all-reps view. */
  ownerNameById?: Record<string, string>
  showOwner?: boolean
}) {
  const active = activeDealFilterCount(filters)
  const owners = Object.entries(ownerNameById ?? {}).sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <details open={active > 0} className="rounded border border-gray-200 bg-white">
      <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium text-gray-700">
        Filters
        {active > 0 && (
          <span className="ml-2 rounded-full bg-echo-yellow px-2 py-0.5 text-[11px] font-semibold text-gray-900">
            {active}
          </span>
        )}
      </summary>

      <form action={action} method="get" className="border-t border-gray-100 px-4 py-3">
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className={LABEL} htmlFor="deal-filter-q">Deal name</label>
            <input
              id="deal-filter-q"
              type="search"
              name={DEAL_FILTER_PARAMS.q}
              defaultValue={filters.q}
              placeholder="Search deal names"
              className={`${FIELD} w-full`}
            />
          </div>

          {pipelines.length > 0 && (
            <div>
              <label className={LABEL} htmlFor="deal-filter-pipeline">Pipeline</label>
              <select
                id="deal-filter-pipeline"
                name={DEAL_FILTER_PARAMS.pipelineId}
                defaultValue={filters.pipelineId}
                className={`${FIELD} w-full`}
              >
                <option value="">Any pipeline</option>
                {pipelines.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>{pipeline.label}</option>
                ))}
              </select>
            </div>
          )}

          {stages.length > 0 && (
            <div>
              <label className={LABEL} htmlFor="deal-filter-stage">Stage</label>
              <select
                id="deal-filter-stage"
                name={DEAL_FILTER_PARAMS.stages}
                defaultValue={filters.stages[0] ?? ''}
                className={`${FIELD} w-full`}
              >
                <option value="">Any stage</option>
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.label}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className={LABEL} htmlFor="deal-filter-depot">Depot</label>
            <select
              id="deal-filter-depot"
              name={DEAL_FILTER_PARAMS.depot}
              defaultValue={filters.depot}
              className={`${FIELD} w-full`}
            >
              <option value="">Any depot</option>
              {/* The VALUE is the long name, not the code. HubSpot's
                  sending_depot is an enumeration whose internal value is
                  "US Baltimore" and whose display label is "US-BAL", the
                  inverse of DEPOT_MAPPING's naming. Verified against the live
                  property on 2026-09-03; sending the code matches nothing. */}
              {Object.entries(DEPOT_MAPPING).map(([code, label]) => (
                <option key={code} value={label}>{label}</option>
              ))}
            </select>
          </div>

          {showOwner && owners.length > 0 && (
            <div>
              <label className={LABEL} htmlFor="deal-filter-owner">Owner</label>
              <select
                id="deal-filter-owner"
                name={DEAL_FILTER_PARAMS.ownerId}
                defaultValue={filters.ownerId}
                className={`${FIELD} w-full`}
              >
                <option value="">Any owner</option>
                {owners.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Company and contact are matched by HubSpot association, which the
              deal search filters on even though it cannot return it. The rep
              types a name; the server resolves it to ids before searching. */}
          <div>
            <label className={LABEL} htmlFor="deal-filter-company">Company</label>
            <input
              id="deal-filter-company"
              type="text"
              name={DEAL_FILTER_PARAMS.company}
              defaultValue={filters.company}
              placeholder="Name or domain"
              className={`${FIELD} w-full`}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="deal-filter-contact">Contact</label>
            <input
              id="deal-filter-contact"
              type="text"
              name={DEAL_FILTER_PARAMS.contact}
              defaultValue={filters.contact}
              placeholder="Name or email"
              className={`${FIELD} w-full`}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="deal-filter-amount-min">Amount from</label>
            <input
              id="deal-filter-amount-min"
              type="number"
              inputMode="decimal"
              name={DEAL_FILTER_PARAMS.amountMin}
              defaultValue={filters.amountMin}
              placeholder="0"
              className={`${FIELD} w-full`}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="deal-filter-amount-max">Amount to</label>
            <input
              id="deal-filter-amount-max"
              type="number"
              inputMode="decimal"
              name={DEAL_FILTER_PARAMS.amountMax}
              defaultValue={filters.amountMax}
              placeholder="Any"
              className={`${FIELD} w-full`}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="deal-filter-created-from">Created from</label>
            <input
              id="deal-filter-created-from"
              type="date"
              name={DEAL_FILTER_PARAMS.createdFrom}
              defaultValue={filters.createdFrom}
              className={`${FIELD} w-full`}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="deal-filter-created-to">Created to</label>
            <input
              id="deal-filter-created-to"
              type="date"
              name={DEAL_FILTER_PARAMS.createdTo}
              defaultValue={filters.createdTo}
              className={`${FIELD} w-full`}
            />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="submit"
            className="rounded border border-echo-yellow bg-yellow-50 px-3 py-1 text-xs font-semibold text-gray-900"
          >
            Apply filters
          </button>
          {active > 0 && (
            <Link
              href={`${action}?${new URLSearchParams(hidden).toString()}`}
              className="rounded border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:border-gray-300"
            >
              Clear
            </Link>
          )}
        </div>
      </form>
    </details>
  )
}
