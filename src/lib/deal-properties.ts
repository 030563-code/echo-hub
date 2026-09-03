/**
 * HubSpot deal properties the Hub reads and writes by name.
 *
 * Pure data and pure helpers, safe on both client and server.
 */

/**
 * The USA Rep Agents property.
 *
 * NOTE THE SUFFIX, IT IS NOT A TYPO. Dean asked for `usa_rep_agents`, and
 * verified live against portal 3882358 on 2026-09-03: no property of that name
 * exists. What exists is `usa_rep_agents__cloned_`, label "USA Rep Agents
 * (Cloned)", created 2024-12-11, an unhidden `enumeration` / `select` with
 * `readOnlyValue: false` and the five options in REP_AGENT_VALUES below. The
 * `__cloned_` suffix is what HubSpot appends when a property is duplicated in
 * the UI, so the original was presumably renamed or deleted afterwards.
 *
 * Dean's call was to use the cloned one as-is rather than wait on a clean
 * property. It lives here as a single constant so that if a tidy
 * `usa_rep_agents` is ever created and its values migrated, this line is the
 * only change needed.
 */
export const REP_AGENT_PROPERTY = 'usa_rep_agents__cloned_'

/** How the field is labelled in the Hub. The HubSpot label carries "(Cloned)",
 *  which is an artefact of how the property was made and means nothing to a
 *  rep, so it is not what we show. */
export const REP_AGENT_LABEL = 'Rep agent'

/**
 * The five live option values, verified against
 * GET /crm/v3/properties/deals/usa_rep_agents__cloned_ on 2026-09-03. Every
 * option's `value` equals its `label`, and none are hidden.
 *
 * This is the FALLBACK for getRepAgentOptions, not the source of truth: the
 * dropdown fetches the live list so an option added in HubSpot appears without
 * a deploy. It exists for the same reason WIN_PROBABILITY_VALUES does, that a
 * network blip used to render an empty select with no error.
 */
export const REP_AGENT_VALUES: readonly string[] = [
  'D T Cores',
  'R C Banner',
  '5 Star Sales',
  'The Sullivan Group',
  'EB Own',
]

/** The fallback in the shape the select consumes. */
export function repAgentFallbackOptions(): { label: string; value: string }[] {
  return REP_AGENT_VALUES.map((value) => ({ label: value, value }))
}

/**
 * Whether a stored value can be shown as the select's current choice.
 *
 * A deal may already carry a value that has since been removed from the
 * property, or one typed in by an import. Rendering that as the Select's value
 * when it is not among the items shows a blank trigger, so the caller needs to
 * know to fall back to plain text instead of silently losing it.
 */
export function isKnownRepAgent(
  value: string | null | undefined,
  options: readonly { value: string }[],
): boolean {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  return options.some((option) => option.value === trimmed)
}
