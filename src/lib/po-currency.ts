import { isOrgCode, orgForDepot, type OrgCode } from "@/lib/organisations";

// Per-leg PO document currency + conversion.
//
// A PO's cost is entered ONCE, on the first (depot) leg, in that depot's currency
// (a US depot → USD). As the order flows down the intercompany chain each leg's PO
// is denominated in ITS OWN entity's currency, so the same cost is shown converted:
//   US depot  → USD  (as entered)
//   EB Group  → GBP
//   EB SRO    → EUR
// Conversion pivots through EUR using the weekly fx_weekly rates (EUR_USD, GBP_EUR,
// EUR_CAD). Pure + client-safe; the rates are fetched server-side and passed in.

export type Currency = "USD" | "GBP" | "EUR" | "CAD";

/**
 * The currency each company's purchase orders are denominated in.
 *
 * Dean, 22 Sep 2026: "Please first fix the currency issue with France it should
 * be Euros." It was US dollars, because this used to be a list of prefixes that
 * named the American and Canadian codes and defaulted everything else to USD.
 * France, the UK and s.r.o.'s own depot all fell into that default, so EBFRA8001
 * priced a French order in dollars.
 *
 * EB-GROUP stays GBP on purpose. The organisation registry lists it as EUR and
 * the Dublin registered address agrees, but every Group purchase order ever sent
 * prints pounds and the Xero tenant is the UK one. Changing it would rewrite
 * documents that are already out. That one is Dean's to settle, not a tidy-up.
 *
 * Australia is the one gap. Its currency is AUD, and fx_weekly carries EUR_USD,
 * GBP_EUR and EUR_CAD only, so there is no rate to convert an Australian order
 * with. It keeps the dollar default until a rate exists, which is harmless while
 * AU-SYD has nothing mapped to order.
 */
const ORG_PO_CURRENCY: Record<OrgCode, Currency> = {
  "EB-USA": "USD",
  "EB-CANADA": "CAD",
  "EB-FRANCE": "EUR",
  "EB-SRO": "EUR",
  "EB-GROUP": "GBP",
  "EB-AUSTRALIA": "USD",
  "EB-UK": "GBP",
};

/**
 * The PO-document currency for an entity OR depot code (its functional currency).
 *
 * Both vocabularies arrive here: the first leg of a chain is raised by a depot
 * (US-BAL, EU-FR, GB-BSE) and every later leg by an entity (EB-GROUP, EB-SRO).
 * A depot is resolved through the company that owns it, so a new depot needs no
 * change in this file.
 */
export function entityPoCurrency(code: string | null | undefined): Currency {
  const c = (code ?? "").trim().toUpperCase();
  if (isOrgCode(c)) return ORG_PO_CURRENCY[c];
  const owner = orgForDepot(c);
  if (owner) return ORG_PO_CURRENCY[owner];
  return "USD"; // SUPPLIER and anything unmapped; most chains root at a US depot.
}

export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", GBP: "£", EUR: "€", CAD: "C$" };

/** The three weekly EUR-pivot rates we need (from mfg fx_weekly). */
export interface FxRates {
  EUR_USD: number; // 1 EUR = x USD
  GBP_EUR: number; // 1 GBP = x EUR
  EUR_CAD: number; // 1 EUR = x CAD
}

/** Amount of `ccy` → EUR. */
function toEur(amount: number, ccy: Currency, fx: FxRates): number {
  switch (ccy) {
    case "EUR": return amount;
    case "USD": return amount / fx.EUR_USD;
    case "GBP": return amount * fx.GBP_EUR;
    case "CAD": return amount / fx.EUR_CAD;
  }
}
/** EUR → amount of `ccy`. */
function fromEur(eur: number, ccy: Currency, fx: FxRates): number {
  switch (ccy) {
    case "EUR": return eur;
    case "USD": return eur * fx.EUR_USD;
    case "GBP": return eur / fx.GBP_EUR;
    case "CAD": return eur * fx.EUR_CAD;
  }
}

/**
 * Convert an amount between two currencies via the EUR pivot. Returns the input
 * unchanged if the currencies match or the required rate is missing/invalid.
 */
export function convertCurrency(amount: number, from: Currency, to: Currency, fx: FxRates | null): number {
  if (from === to || !fx) return amount;
  const ok = [fx.EUR_USD, fx.GBP_EUR, fx.EUR_CAD].every((r) => Number.isFinite(r) && r > 0);
  if (!ok) return amount;
  return fromEur(toEur(amount, from, fx), to, fx);
}
