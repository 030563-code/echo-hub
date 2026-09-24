import type * as JsPdfModule from 'jspdf'

/**
 * Every string a PDF renderer asks jsPDF to draw, in the order it drew them.
 *
 * The renderers draw with a subset Unicode font, so the finished bytes hold glyph ids rather than
 * readable words and searching them proves nothing. What the renderer asked jsPDF to draw is what
 * the page shows. autoTable draws its headings and cells through the same doc.text, so those are
 * recorded too.
 *
 * In a test file (vi.mock is hoisted, so the array has to be as well):
 *
 *   const drawn = vi.hoisted(() => [] as string[])
 *   vi.mock('jspdf', async (original) =>
 *     (await import('./pdf-text')).recordingJsPdf(await original<typeof import('jspdf')>(), drawn))
 */
export function recordingJsPdf(real: typeof JsPdfModule, drawn: string[]) {
  const Real = real.jsPDF
  function Recording(...args: ConstructorParameters<typeof Real>) {
    const doc = new Real(...args)
    const text = doc.text.bind(doc) as (...a: unknown[]) => ReturnType<typeof doc.text>
    doc.text = ((value: string | string[], ...rest: unknown[]) => {
      drawn.push(...(Array.isArray(value) ? value : [value]))
      return text(value, ...rest)
    }) as typeof doc.text
    return doc
  }
  // Keep the statics (API, version) that a caller may reach for through the class.
  Object.assign(Recording, Real)
  return { ...real, default: Recording, jsPDF: Recording }
}
