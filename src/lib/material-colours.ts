/**
 * Which colours a fabric can be ordered in, and how a material line finds them.
 *
 * Juraj, 22 Sep 2026: "could we also add colours options to the PC350FR and P200", then the list:
 * PC350FR in Black, Navy blue, Maroon, Beige and White; P200 in Flo orange, Flo yellow and White.
 * These are the two Goretex fabrics Echo Barrier supplies to Bamida. P200 is the H10 family's,
 * spelled PC200FR on the standing specification; PC350FR is everybody else's. The colour is
 * decided per order: a French order may be beige, a US one black. Until now the -1 specification
 * printed the roll and no colour at all, and the colour travelled by WhatsApp.
 *
 * The options live in material_colour_option, keyed by FAMILY, because the bill of materials spells
 * the fabric by roll (PC350FR-UV21, PC350FR-UV15) and the colour belongs to the cloth, not the
 * width. Pure, so the editor and the builder share one rule and the tests can pin it.
 */

export type ColourOptions = ReadonlyMap<string, readonly string[]>

/** The family a material code belongs to: the longest family that starts it, or null. */
export function colourFamilyFor(code: string | null | undefined, families: Iterable<string>): string | null {
  const upper = String(code ?? '').trim().toUpperCase()
  if (!upper) return null
  let best: string | null = null
  for (const family of families) {
    const f = family.trim().toUpperCase()
    if (f && upper.startsWith(f) && (best === null || f.length > best.length)) best = family
  }
  return best
}

/** The colours a material can be ordered in, or an empty list when it is not a coloured fabric. */
export function colourOptionsFor(code: string | null | undefined, options: ColourOptions): readonly string[] {
  const family = colourFamilyFor(code, options.keys())
  return family ? (options.get(family) ?? []) : []
}

/**
 * The option a standing colour means, when it means one.
 *
 * model_spec writes colours bilingually ("Čierna/Black", "Oranžová/Orange"), so an option matches
 * when its last word appears among the words of the standing text: "Black" finds "Čierna/Black"
 * and "Flo orange" finds "Oranžová/Orange". An exact match wins over a word match. No match is
 * null rather than a guess: the editor then shows the fabric with no colour chosen, which is the
 * truth, and Juraj picks one.
 */
export function pickColourOption(standing: string | null | undefined, options: readonly string[]): string | null {
  const text = String(standing ?? '').trim().toLowerCase()
  if (!text || options.length === 0) return null
  const exact = options.find((o) => o.trim().toLowerCase() === text)
  if (exact) return exact
  const words = new Set(text.split(/[^\p{L}]+/u).filter(Boolean))
  return (
    options.find((o) => {
      const parts = o.trim().toLowerCase().split(/\s+/)
      return words.has(parts[parts.length - 1])
    }) ?? null
  )
}

/** The wire form (a server action's state is plain JSON) back into the Map the rules take. */
export function toColourOptions(record: Record<string, readonly string[]>): ColourOptions {
  return new Map(Object.entries(record))
}
