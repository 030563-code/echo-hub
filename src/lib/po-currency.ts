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

/** The PO-document currency for an entity/depot code (its functional currency). */
export function entityPoCurrency(code: string | null | undefined): Currency {
  const c = (code ?? "").toUpperCase();
  if (c.startsWith("US-") || c === "EB-USA") return "USD";
  if (c.startsWith("CA-") || c === "EB-CANADA") return "CAD";
  if (c === "EB-GROUP") return "GBP";
  if (c === "EB-SRO") return "EUR";
  return "USD"; // sensible default (most chains root at a US depot)
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
