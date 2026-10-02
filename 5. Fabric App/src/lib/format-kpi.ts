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
    const shown = format === "millions" ? value * 1_000_000 : value;
    return `${options.prefix ?? ""}${formatters[format].format(shown)}${format === "multiple" ? "×" : ""}`;
}
