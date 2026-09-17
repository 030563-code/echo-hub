/**
 * A font that can actually spell Slovak.
 *
 * 🔴 jsPDF's built-in Helvetica is encoded WinAnsi (CP1252), which does not
 * contain the Slovak caron letters. Rendering the live model_spec rows through
 * it did not merely drop them, it printed the WRONG characters, on the document
 * the factory builds from:
 *
 *     Čierna/Black          ->  ierna/Black
 *     podľa štandardov      ->  pod>a štandardov
 *     Mesh (sieťka)         ->  Mesh (sieeka)
 *     Include (pribaliť)    ->  Include (pribalie)
 *     UV biela tlač         ->  UV biela tla
 *     označovanie paliet    ->  oznaovanie paliet
 *
 * c d l n r t and their capitals all carry a caron in Slovak and all nine are
 * outside CP1252. á é í ó ú ý ô ä š ž happen to be inside it, which is why the
 * damage looked like a typo rather than an encoding fault.
 *
 * Liberation Sans is metric-compatible with Helvetica, so swapping to it moves
 * nothing that was already laid out, and it is subset here to Latin-1 plus
 * Latin Extended-A: 24 KB per weight rather than 140 KB. Both weights are
 * imported statically so the bytes are traced into the serverless bundle; every
 * module that reaches this one is server-side, so they never reach a browser.
 *
 * Regenerate the two data files with:
 *   python3 -m fontTools.subset LiberationSans-Regular.ttf \
 *     --unicodes=U+0020-007E,U+00A0-00FF,U+0100-017F,U+2013-2014,U+2018-201A,\
 *     U+201C-201E,U+2022,U+2026,U+20AC,U+00B7,U+2122 \
 *     --layout-features='*' --no-hinting --desubroutinize --drop-tables+=DSIG \
 *     --output-file=LiberationSans-Regular.subset.ttf
 * then base64 the result into `src/lib/pdf-fonts/`.
 */

import type { jsPDF } from 'jspdf'
import { LIBERATION_SANS_REGULAR } from '@/lib/pdf-fonts/liberation-sans-regular'
import { LIBERATION_SANS_BOLD } from '@/lib/pdf-fonts/liberation-sans-bold'

/** The family name the document asks for once `registerUnicodeFont` has run. */
export const UNICODE_FONT = 'LiberationSans'

/**
 * Register the font and select it. Returns the family the caller should use.
 *
 * Falls back to helvetica rather than throwing: a document that spells one word
 * wrong is worth far more to the factory than no document at all, and the
 * caller has no better answer to a font that would not load.
 */
export function registerUnicodeFont(doc: jsPDF): string {
  try {
    doc.addFileToVFS('LiberationSans-Regular.ttf', LIBERATION_SANS_REGULAR)
    doc.addFont('LiberationSans-Regular.ttf', UNICODE_FONT, 'normal')
    doc.addFileToVFS('LiberationSans-Bold.ttf', LIBERATION_SANS_BOLD)
    doc.addFont('LiberationSans-Bold.ttf', UNICODE_FONT, 'bold')
    doc.setFont(UNICODE_FONT, 'normal')
    return UNICODE_FONT
  } catch {
    doc.setFont('helvetica', 'normal')
    return 'helvetica'
  }
}
