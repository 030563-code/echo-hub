/**
 * Splitting a typed full name into HubSpot's firstname and lastname.
 *
 * HubSpot has no writable full-name property (hs_full_name is read-only and
 * composed from the two), so the convenience field in the create-contact
 * dialog has to split client-side.
 *
 * The rule for three or more words: the FIRST token is the given name and
 * everything after it is the surname, so "Jean Luc Picard" becomes Jean and
 * "Luc Picard". That is the wrong call for a genuine middle name, and the
 * right one for van der Berg, De La Cruz and Dos Santos, which are far commoner
 * in this dataset. Both fields stay editable, so a wrong split costs one
 * keystroke.
 */
export function splitFullName(input: string): { firstname: string; lastname: string } {
  const parts = String(input ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstname: '', lastname: '' }
  if (parts.length === 1) return { firstname: parts[0], lastname: '' }
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') }
}

/** The inverse, for keeping the convenience field in step with edits to the
 *  two real ones. */
export function joinFullName(firstname: string, lastname: string): string {
  return [firstname, lastname].map((p) => String(p ?? '').trim()).filter(Boolean).join(' ')
}
