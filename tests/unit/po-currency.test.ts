import { describe, it, expect } from "vitest";
import { entityPoCurrency, convertCurrency, type FxRates } from "@/lib/po-currency";
import { isPlaceholderPoNumber, displayPoNumber, AWAITING_XERO_PO } from "@/lib/po-number";

const FX: FxRates = { EUR_USD: 1.14234, GBP_EUR: 1.17124, EUR_CAD: 1.62092 };

describe("entityPoCurrency", () => {
  it("maps each leg's entity to its functional currency", () => {
    expect(entityPoCurrency("US-BAL")).toBe("USD");
    expect(entityPoCurrency("US-SBD")).toBe("USD");
    expect(entityPoCurrency("EB-USA")).toBe("USD");
    expect(entityPoCurrency("CA-HAM")).toBe("CAD");
    expect(entityPoCurrency("EB-GROUP")).toBe("GBP");
    expect(entityPoCurrency("EB-SRO")).toBe("EUR");
    expect(entityPoCurrency("SUPPLIER")).toBe("USD"); // default
    expect(entityPoCurrency(null)).toBe("USD");
  });

  // Dean, 22 Sep 2026: "Please first fix the currency issue with France it
  // should be Euros." It was dollars: this used to be a list of prefixes naming
  // the American and Canadian codes, and every other region fell into the
  // dollar default, so EBFRA8001 priced a French order in USD.
  it("prices a French order in euros and a British one in pounds", () => {
    expect(entityPoCurrency("EU-FR")).toBe("EUR");
    expect(entityPoCurrency("EB-FRANCE")).toBe("EUR");
    expect(entityPoCurrency("GB-BSE")).toBe("GBP");
    expect(entityPoCurrency("EB-UK")).toBe("GBP");
    expect(entityPoCurrency("EU-SK")).toBe("EUR");
  });

  it("resolves a depot through the company that owns it, not a prefix", () => {
    // Every depot in the registry lands on its organisation's currency, so a
    // new depot needs no change in po-currency.ts.
    for (const [depot, expected] of [
      ["us-bal", "USD"], ["ca-ham", "CAD"], ["eu-fr", "EUR"],
      ["gb-bse", "GBP"], ["eu-sk", "EUR"],
    ] as const) {
      expect(entityPoCurrency(depot), depot).toBe(expected);
      expect(entityPoCurrency(` ${depot.toUpperCase()} `), depot).toBe(expected);
    }
  });

  it("leaves Group in pounds, because every Group order ever sent is in pounds", () => {
    // The organisation registry says EUR and the registered address is Dublin.
    // Changing it would rewrite documents that are already out, so it is Dean's
    // call and not a tidy-up. Pinned here so nobody "fixes" it by accident.
    expect(entityPoCurrency("EB-GROUP")).toBe("GBP");
  });

  it("keeps Australia on the default, because there is no AUD rate to convert with", () => {
    // fx_weekly carries EUR_USD, GBP_EUR and EUR_CAD only. Harmless while
    // AU-SYD has nothing mapped to order; revisit when a rate exists.
    expect(entityPoCurrency("AU-SYD")).toBe("USD");
    expect(entityPoCurrency("EB-AUSTRALIA")).toBe("USD");
  });
});

describe("convertCurrency — the USD→GBP→EUR chain", () => {
  it("is identity for same currency or missing fx", () => {
    expect(convertCurrency(100, "USD", "USD", FX)).toBe(100);
    expect(convertCurrency(100, "USD", "GBP", null)).toBe(100);
  });
  it("converts USD → EUR and USD → GBP via the EUR pivot", () => {
    expect(convertCurrency(100, "USD", "EUR", FX)).toBeCloseTo(100 / 1.14234, 4);
    expect(convertCurrency(100, "USD", "GBP", FX)).toBeCloseTo(100 / 1.14234 / 1.17124, 4);
  });
  it("converts GBP → EUR and EUR → USD directly", () => {
    expect(convertCurrency(100, "GBP", "EUR", FX)).toBeCloseTo(117.124, 3);
    expect(convertCurrency(100, "EUR", "USD", FX)).toBeCloseTo(114.234, 3);
  });
  it("round-trips within rounding", () => {
    const gbp = convertCurrency(250, "USD", "GBP", FX);
    expect(convertCurrency(gbp, "GBP", "USD", FX)).toBeCloseTo(250, 6);
  });
  it("treats a non-positive/NaN rate as unavailable (no conversion)", () => {
    expect(convertCurrency(100, "USD", "EUR", { EUR_USD: 0, GBP_EUR: 1.1, EUR_CAD: 1.6 })).toBe(100);
    expect(convertCurrency(100, "USD", "EUR", { EUR_USD: NaN, GBP_EUR: 1.1, EUR_CAD: 1.6 })).toBe(100);
  });
});

describe("displayPoNumber — show whatever number the order has", () => {
  it("treats PO-NNNNN as a placeholder", () => {
    expect(isPlaceholderPoNumber("PO-01105")).toBe(true);
    expect(isPlaceholderPoNumber("PO-1")).toBe(true);
    expect(isPlaceholderPoNumber(null)).toBe(true);
    expect(isPlaceholderPoNumber("")).toBe(true);
  });
  it("treats real Xero numbers as real", () => {
    expect(isPlaceholderPoNumber("EBG26086")).toBe(false);
    expect(isPlaceholderPoNumber("EBUSA26013")).toBe(false);
    expect(isPlaceholderPoNumber("EBSRO2026001-01")).toBe(false);
  });
  it("shows the Hub number rather than hiding it behind the awaiting label", () => {
    // Dean, 2026-09-07: the Xero hand-off is off for the feedback round, so no
    // Xero number is coming and an order with no visible number cannot be
    // discussed or searched for. The Xero number replaces it once n8n writes back.
    expect(displayPoNumber("PO-01105")).toBe("PO-01105");
    expect(displayPoNumber("EBG26086")).toBe("EBG26086");
  });
  it("falls back to the awaiting label only when there is no number at all", () => {
    expect(displayPoNumber(null)).toBe(AWAITING_XERO_PO);
    expect(displayPoNumber("")).toBe(AWAITING_XERO_PO);
    expect(displayPoNumber("   ")).toBe(AWAITING_XERO_PO);
  });
});
