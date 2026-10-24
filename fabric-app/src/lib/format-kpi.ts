//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** How a figure should be rendered when it is present. */
export type KpiFormat = "whole" | "percent" | "rate" | "hours" | "currency" | "money" | "price" | "multiple" | "millions";

interface FormatKpiOptions {
    /** Symbol or short unit printed directly before a present value. */
    prefix?: string;
    /**
     * Shortens a count or amount of a million or more to 5.9M, for a card or
     * a sentence, and drops the cents from money of a thousand or more. Show
     * the exact figure beside it, as a tooltip.
     */
    compact?: boolean;
}

/** Where a compact figure starts to shorten: below it, every digit fits a card. */
export const COMPACT_FROM = 1_000_000;
/** Figures that stay small whatever the tenant's size, so never shorten. */
const BOUNDED: ReadonlySet<KpiFormat> = new Set(["percent", "rate", "multiple", "price"]);
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const SCALES: ReadonlyArray<readonly [number, string]> = [[1e6, "M"], [1e9, "B"], [1e12, "T"]];

/**
 * 5.9M, 154.5M, 1.5B: the same letters whatever the browser's language,
 * which would otherwise give "5.9m", "5,9 Mio." or lakh.
 */
function shorten(value: number): string {
    for (const [index, [size, suffix]] of SCALES.entries()) {
        const scaled = Math.round((value / size) * 10) / 10;
        if (Math.abs(scaled) < 1000 || index === SCALES.length - 1) return `${oneDecimal.format(scaled)}${suffix}`;
    }
    return oneDecimal.format(value);
}

const formatters: Record<KpiFormat, Intl.NumberFormat> = {
    whole: new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    percent: new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }),
    rate: new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    hours: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }),
    currency: new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    // Billed amounts, where cents matter: small agents cost well under a unit.
    money: new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    // Unit prices such as cost per credit, which live in the fourth decimal.
    price: new Intl.NumberFormat(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    // How many times one figure covers another, such as value over cost: 5.4×.
    multiple: new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    // A count the model reports in millions, such as tokens, shown at its own
    // scale: 0.000212 is 212, and 1.25 is 1.3M.
    millions: new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }),
};

/**
 * Formats a figure for display, or returns an em dash when the model returned
 * BLANK. A missing figure must never be shown as a zero — the two mean very
 * different things in this report.
 */
export function formatKpi(value: number | undefined, format: KpiFormat, options: FormatKpiOptions = {}): string {
    if (value === undefined) return "—";
    const prefix = options.prefix ?? "";
    // A real spend under half a cent would round to 0.00 and read as free.
    if (format === "money" && value > 0 && value < 0.005) return `<${prefix}${formatters.money.format(0.01)}`;
    const shown = format === "millions" ? value * 1_000_000 : value;
    // A loss must not round up to break-even: 0.96× would print as 1.0×.
    if (format === "multiple" && value >= 0 && value < 1 && Math.round(value * 10) >= 10) {
        return `${prefix}${formatters.rate.format(Math.floor(value * 100) / 100)}×`;
    }
    if (options.compact && !BOUNDED.has(format) && Math.abs(shown) >= COMPACT_FROM) {
        return `${prefix}${shorten(shown)}`;
    }
    // A tenth of an hour, or a cent, is noise on a figure in the thousands.
    const whole = (format === "hours" || (format === "money" && options.compact)) && Math.abs(shown) >= 1000;
    return `${prefix}${(whole ? formatters.whole : formatters[format]).format(shown)}${format === "multiple" ? "×" : ""}`;
}
