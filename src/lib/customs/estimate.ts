import { entryHmf, entryMpf, roundCents, wholeDollars } from '@/lib/customs/fees'
import { DUTY_RULES, dutyRuleFor, originGroup, type DutyRule, type ProductClass } from '@/lib/customs/duty'

/**
 * What a container on its way to the US will cost in duty and fees, before Nippon's invoice.
 *
 * Dean, 23 Sep 2026: "We should be also automatically be able to precalculate the duty tax from
 * ur information in the system", on the shipment Transport already tracks by SPOT ID.
 *
 * The value is the one booked with Cargo Partner, which is the Group invoice: sometimes the goods
 * alone (242167963: 54,125.50), sometimes with the freight and insurance (244498887: 79,465.63).
 * CBP charges on the goods and the palletising only, so the estimate can run high; the entry
 * decides, and the Customs tab shows the real figure when Nippon's invoice arrives.
 */

export interface CustomsEstimate {
  enteredValue: number
  rule: DutyRule
  duty: number
  mpf: number
  hmf: number
  total: number
}

export type EstimateResult = { ok: true; estimate: CustomsEstimate } | { ok: false; reason: string }

export function estimateCustoms(input: {
  goodsValue: number | null
  currency: string | null
  originCountry: string | null
  /** The day it is expected to be entered: the ETA, or today once it has arrived. */
  onDate: string
  productClass?: ProductClass
  rules?: readonly DutyRule[]
}): EstimateResult {
  const { goodsValue, currency, originCountry, onDate, productClass = 'acoustic', rules = DUTY_RULES } = input
  if (goodsValue == null || !(goodsValue > 0)) return { ok: false, reason: 'No value was booked with Cargo Partner for this shipment.' }
  if ((currency ?? '').toUpperCase() !== 'USD') {
    return { ok: false, reason: `The value was booked in ${currency ?? 'an unknown currency'}, so there is no dollar estimate before the entry.` }
  }
  const origin = originGroup(originCountry)
  if (!origin) return { ok: false, reason: `No duty rule covers goods from ${originCountry ?? 'an unknown country'}.` }
  const rule = dutyRuleFor(productClass, origin, onDate, rules)
  if (!rule) return { ok: false, reason: `No duty rate is on file for these goods on ${onDate}.` }

  const enteredValue = wholeDollars(goodsValue)
  const duty = roundCents(enteredValue * rule.rate)
  const mpf = entryMpf([enteredValue], onDate).amount
  const hmf = entryHmf([enteredValue])
  return { ok: true, estimate: { enteredValue, rule, duty, mpf, hmf, total: roundCents(duty + mpf + hmf) } }
}
