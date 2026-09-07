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

describe("displayPoNumber — hide Hub placeholders, show Xero numbers", () => {
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
  it("displays the awaiting label for placeholders, the number otherwise", () => {
    expect(displayPoNumber("PO-01105")).toBe(AWAITING_XERO_PO);
    expect(displayPoNumber("EBG26086")).toBe("EBG26086");
  });
});
