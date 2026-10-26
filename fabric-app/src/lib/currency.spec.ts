//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
    CURRENCIES,
    currencyPrefix,
    currencySymbol,
    legacyCurrencyFromSymbol,
    resolveReportingCurrency,
    toCurrencyCode,
} from "./currency";

describe("currency", () => {
    it("offers US dollars first and each code once", () => {
        expect(CURRENCIES[0].code).toBe("USD");
        expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(CURRENCIES.length);
    });

    it("reads only codes it offers, in any case", () => {
        expect(toCurrencyCode(" gbp ")).toBe("GBP");
        expect(toCurrencyCode("XYZ")).toBeUndefined();
        expect(toCurrencyCode(42)).toBeUndefined();
    });

    it("prints a symbol, or the code and a space", () => {
        expect(currencyPrefix("USD")).toBe("$");
        expect(currencyPrefix("eur")).toBe("€");
        expect(currencyPrefix("CHF")).toBe("CHF ");
        expect(currencyPrefix("HUF")).toBe("HUF ");
        expect(currencyPrefix(undefined)).toBe("");
        expect(currencySymbol("SEK")).toBe("SEK");
    });

    it("reads the model's old symbol as a code, with the shipped £ as the fallback", () => {
        expect(legacyCurrencyFromSymbol("£")).toBe("GBP");
        expect(legacyCurrencyFromSymbol("$")).toBe("USD");
        expect(legacyCurrencyFromSymbol(" € ")).toBe("EUR");
        expect(legacyCurrencyFromSymbol("JPY")).toBe("JPY");
        expect(legacyCurrencyFromSymbol("R")).toBe("ZAR");
        expect(legacyCurrencyFromSymbol("CHF")).toBe("CHF");
        expect(legacyCurrencyFromSymbol(undefined)).toBe("GBP");
        expect(legacyCurrencyFromSymbol("?")).toBe("GBP");
    });

    describe("resolveReportingCurrency", () => {
        it("defaults to US dollars, which need no rate", () => {
            expect(resolveReportingCurrency({})).toMatchObject({ code: "USD", prefix: "$", isUsd: true, exchangeRate: undefined, source: "default" });
        });

        it("uses the installer's choice and rate before anything is saved", () => {
            expect(resolveReportingCurrency({ install: { currency: "EUR", exchangeRate: 0.92 } })).toMatchObject({
                code: "EUR",
                exchangeRate: 0.92,
                source: "install",
            });
        });

        it("puts the saved currency and rate first", () => {
            const resolved = resolveReportingCurrency({
                saved: { currency: "GBP", exchangeRate: 0.79 },
                install: { currency: "EUR", exchangeRate: 0.92 },
            });
            expect(resolved).toMatchObject({ code: "GBP", exchangeRate: 0.79, source: "saved" });
        });

        it("falls back to the installer's rate when the saved currency matches it and has none", () => {
            expect(resolveReportingCurrency({ saved: { currency: "EUR" }, install: { currency: "EUR", exchangeRate: 0.92 } }).exchangeRate).toBe(0.92);
            expect(resolveReportingCurrency({ saved: { currency: "GBP" }, install: { currency: "EUR", exchangeRate: 0.92 } }).exchangeRate).toBeUndefined();
        });

        it("ignores any rate once the currency is US dollars", () => {
            expect(resolveReportingCurrency({ saved: { currency: "USD", exchangeRate: 0.79 } })).toMatchObject({ isUsd: true, exchangeRate: undefined });
        });

        it("keeps an older install's saved rate in the model's currency", () => {
            expect(resolveReportingCurrency({ saved: { exchangeRate: 0.79 }, modelSymbol: "£" })).toMatchObject({
                code: "GBP",
                exchangeRate: 0.79,
                source: "legacy",
            });
        });

        it("lets the installer's choice win over an older install's rate, which is only kept for the same currency", () => {
            expect(resolveReportingCurrency({ saved: { exchangeRate: 0.79 }, install: { currency: "USD" }, modelSymbol: "£" })).toMatchObject({
                code: "USD",
                exchangeRate: undefined,
            });
            expect(resolveReportingCurrency({ saved: { exchangeRate: 0.79 }, install: { currency: "EUR" }, modelSymbol: "£" })).toMatchObject({
                code: "EUR",
                exchangeRate: undefined,
            });
            expect(resolveReportingCurrency({ saved: { exchangeRate: 0.79 }, install: { currency: "GBP" }, modelSymbol: "£" })).toMatchObject({
                code: "GBP",
                exchangeRate: 0.79,
            });
        });
    });
});
