/**
 * UN/LOCODE → the name a person would say.
 *
 * The shipment payload gives a routing point a code and a country and no name,
 * so a board built straight off it reads "DEBRV" where the freight forwarder's
 * own screen reads "Bremerhaven". These are the 24 codes that appear anywhere in
 * the 25 real payloads on 22 Sep 2026.
 *
 * An unknown code falls through as itself rather than as "Unknown". A code
 * somebody recognises beats a word that tells them nothing, which is the same
 * contract depotLabel and orgLabel already keep.
 */
export const UNLOCODE_PLACES: Record<string, string> = {
  BEANR: 'Antwerp',
  CAHAM: 'Hamilton',
  CAMTR: 'Montreal',
  CASJB: 'Saint John',
  CATOR: 'Toronto',
  CZOSR: 'Ostrava',
  CZZLN: 'Zlin',
  DEBRV: 'Bremerhaven',
  DEHAM: 'Hamburg',
  GBBSE: 'Bury St Edmunds',
  GBFXT: 'Felixstowe',
  GBLGP: 'London Gateway',
  SKDJA: 'Dunajska Streda',
  SKKSC: 'Kosice',
  SKPOV: 'Presov',
  USBAL: 'Baltimore',
  USCLT: 'Charlotte',
  USLAX: 'Los Angeles',
  USLGB: 'Long Beach',
  USORF: 'Norfolk',
  USPTM: 'Portsmouth',
  USRCU: 'Rancho Cucamonga',
  USSBT: 'San Bernardino',
  USXHB: 'Harrisburg',
}

export function placeName(unlocode: string | null | undefined): string | null {
  const code = (unlocode ?? '').trim().toUpperCase()
  if (!code) return null
  return UNLOCODE_PLACES[code] ?? code
}

/**
 * Title case for the cities the API shouts ("PRESOV", "BURY ST. EDMUNDS") and
 * leaves alone the ones it does not ("Rancho Cucamonga"). Slovak diacritics
 * survive, because toLowerCase and toUpperCase are locale independent here.
 */
export function tidyCity(city: string | null | undefined): string | null {
  const raw = (city ?? '').trim()
  if (!raw) return null
  if (raw !== raw.toUpperCase()) return raw
  return raw
    .toLowerCase()
    .replace(/(^|[\s'\-/])([a-zà-ÿ])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase())
}

/** SEA_FCL → 'sea'. What the timeline draws between two stops. */
export type LegMode = 'sea' | 'rail' | 'road' | 'air' | null

export function legMode(modality: string | null | undefined): LegMode {
  const m = (modality ?? '').toUpperCase()
  if (m.startsWith('SEA')) return 'sea'
  if (m.startsWith('RAIL')) return 'rail'
  if (m.startsWith('ROAD')) return 'road'
  if (m.startsWith('AIR')) return 'air'
  return null
}
