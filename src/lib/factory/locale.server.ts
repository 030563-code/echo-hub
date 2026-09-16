import 'server-only'

import { cookies } from 'next/headers'
import {
  DEFAULT_FACTORY_LOCALE,
  FACTORY_LOCALE_COOKIE,
  isFactoryLocale,
  strings,
  type FactoryLocale,
  type FactoryStrings,
} from './strings'

/**
 * Which language the manufacturer's screens are in for this request.
 *
 * The cookie is a preference and nothing else: it gates no data and widens no
 * access, so an unknown or planted value costs nothing and simply falls back to
 * Slovak. Same shape as activeOrganisation reading hub_org.
 */
export async function factoryLocale(): Promise<FactoryLocale> {
  const jar = await cookies()
  const value = jar.get(FACTORY_LOCALE_COOKIE)?.value
  return isFactoryLocale(value) ? value : DEFAULT_FACTORY_LOCALE
}

/** The locale and its table together, which is what a server action wants. */
export async function factoryStrings(): Promise<{ locale: FactoryLocale; t: FactoryStrings }> {
  const locale = await factoryLocale()
  return { locale, t: strings(locale) }
}
