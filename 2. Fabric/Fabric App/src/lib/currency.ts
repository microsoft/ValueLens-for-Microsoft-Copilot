//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** The reporting currency when nothing else is set: licences and credits are billed in it. */
export const DEFAULT_CURRENCY = "USD";

export interface CurrencyOption {
    /** ISO 4217 code. */
    code: string;
    name: string;
    /** Printed directly before an amount. Codes without a well-known symbol end in a space. */
    prefix: string;
}

/** The reporting currencies the app offers. Add a row here to offer another. */
export const CURRENCIES: readonly CurrencyOption[] = [
    { code: "USD", name: "US dollar", prefix: "$" },
    { code: "EUR", name: "Euro", prefix: "€" },
    { code: "GBP", name: "British pound", prefix: "£" },
    { code: "AUD", name: "Australian dollar", prefix: "A$" },
    { code: "BRL", name: "Brazilian real", prefix: "R$" },
    { code: "CAD", name: "Canadian dollar", prefix: "C$" },
    { code: "CHF", name: "Swiss franc", prefix: "CHF " },
    { code: "DKK", name: "Danish krone", prefix: "DKK " },
    { code: "INR", name: "Indian rupee", prefix: "₹" },
    { code: "JPY", name: "Japanese yen", prefix: "¥" },
    { code: "MXN", name: "Mexican peso", prefix: "MX$" },
    { code: "NOK", name: "Norwegian krone", prefix: "NOK " },
    { code: "NZD", name: "New Zealand dollar", prefix: "NZ$" },
    { code: "SEK", name: "Swedish krona", prefix: "SEK " },
    { code: "SGD", name: "Singapore dollar", prefix: "S$" },
    { code: "ZAR", name: "South African rand", prefix: "R " },
];

const BY_CODE = new Map(CURRENCIES.map((currency) => [currency.code, currency]));

/** The upper-case code when it is one the app offers, otherwise undefined. */
export function toCurrencyCode(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const code = value.trim().toUpperCase();
    return BY_CODE.has(code) ? code : undefined;
}

/**
 * A symbol for a currency, or its ISO code and a space for the rest, so
 * amounts in any currency, including Azure's billing currency, can be told
 * apart. Empty when there is no currency.
 */
export function currencyPrefix(currency: string | undefined): string {
    if (!currency) return "";
    const code = currency.trim().toUpperCase();
    return BY_CODE.get(code)?.prefix ?? `${code} `;
}

/** The currency's prefix without a trailing space, for "per $1" and headers. */
export function currencySymbol(currency: string | undefined): string {
    return currencyPrefix(currency).trim();
}

/** The model's `Currency Symbol Value`, which shipped as "£" and the installer now sets, read as a code. */
const LEGACY_SYMBOLS: Record<string, string> = {
    "$": "USD",
    "US$": "USD",
    "£": "GBP",
    "€": "EUR",
    "¥": "JPY",
    "A$": "AUD",
    "C$": "CAD",
    "₹": "INR",
    "R$": "BRL",
};

/** The currency a model symbol stood for. An unknown or missing symbol is the shipped "£". */
export function legacyCurrencyFromSymbol(symbol: string | undefined): string {
    const trimmed = symbol?.trim() ?? "";
    return LEGACY_SYMBOLS[trimmed] ?? CURRENCIES.find((c) => c.prefix.trim() === trimmed)?.code ?? toCurrencyCode(trimmed) ?? "GBP";
}

/** The reporting currency the installer chose, before anything is saved in the app. */
export interface InstallCurrency {
    currency: string;
    exchangeRate?: number;
}

export interface ReportingCurrency {
    /** ISO code every Value page figure is shown in. */
    code: string;
    /** Printed before an amount. */
    prefix: string;
    /** Whether that is the US dollar, so dollar costs need no exchange rate. */
    isUsd: boolean;
    /** Reporting currency per US dollar, when one applies. Undefined for USD. */
    exchangeRate: number | undefined;
    /** Where the currency came from. */
    source: "saved" | "legacy" | "install" | "default";
}

interface ResolveInput {
    saved?: { currency?: string; exchangeRate?: number } | null;
    install?: InstallCurrency;
    /** The model's `Currency Symbol Value`, read only for installs that saved a rate before currency was a setting. */
    modelSymbol?: string;
}

/**
 * The currency the Value page reports in: the one saved in the app, then the
 * installer's choice, then, for an older install that saved an exchange rate
 * before currency was a setting, the model's symbol, then US dollars.
 *
 * A rate saved before currency was a setting is that symbol's currency per
 * dollar, so it is only used while the currency is still that one.
 */
export function resolveReportingCurrency({ saved, install, modelSymbol }: ResolveInput): ReportingCurrency {
    const savedCode = toCurrencyCode(saved?.currency);
    const installCode = toCurrencyCode(install?.currency);
    const savedRate = saved?.exchangeRate;
    const legacyRate = savedRate !== undefined && !savedCode;
    let code: string;
    let source: ReportingCurrency["source"];
    if (savedCode) {
        code = savedCode;
        source = "saved";
    } else if (installCode) {
        code = installCode;
        source = "install";
    } else if (legacyRate) {
        code = legacyCurrencyFromSymbol(modelSymbol);
        source = "legacy";
    } else {
        code = DEFAULT_CURRENCY;
        source = "default";
    }
    const isUsd = code === "USD";
    const ownRate = legacyRate && legacyCurrencyFromSymbol(modelSymbol) !== code ? undefined : savedRate;
    const installRate = installCode === code ? install?.exchangeRate : undefined;
    return {
        code,
        prefix: currencyPrefix(code),
        isUsd,
        exchangeRate: isUsd ? undefined : (ownRate ?? installRate),
        source,
    };
}
