//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { SummaryResult } from "@/hooks/use-table-query";
import { formatDateRange } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, readText } from "@/lib/summary-row";
import { currencyPrefix, isoDate } from "@/queries/consumption";

export interface AzureBilling {
    studioCost: number | undefined;
    studioCredits: number | undefined;
    coworkCost: number | undefined;
    coworkCredits: number | undefined;
    otherCost: number | undefined;
    totalCost: number | undefined;
    /** The one currency Azure billed in, or undefined when it billed in several. */
    currency: string | undefined;
    currencies: string | undefined;
    subscriptions: number;
    window: string | undefined;
}

/** What Azure billed for Copilot pay-as-you-go, or undefined when it billed nothing or the model predates it. */
export function readAzureBilling(summary: SummaryResult): AzureBilling | undefined {
    const row = summary.row;
    if (summary.error || !row || (readNumber(row, "[Rows]") ?? 0) === 0) return undefined;
    const first = isoDate(readText(row, "[First Date]"));
    const last = isoDate(readText(row, "[Last Date]"));
    return {
        studioCost: readNumber(row, "[Studio Cost]"),
        studioCredits: readNumber(row, "[Studio Credits]"),
        coworkCost: readNumber(row, "[Cowork Cost]"),
        coworkCredits: readNumber(row, "[Cowork Credits]"),
        otherCost: readNumber(row, "[Other Cost]"),
        totalCost: readNumber(row, "[Total Cost]"),
        currency: readText(row, "[Currency]") || undefined,
        currencies: readText(row, "[Currencies]") || undefined,
        subscriptions: readNumber(row, "[Subscriptions]") ?? 0,
        window: first && last ? formatDateRange(first, last) : undefined,
    };
}

/** An amount Azure billed, with its credits when the meter counted any. */
export function billedText(billing: AzureBilling, cost: number | undefined, credits?: number): string | undefined {
    if (cost === undefined) return undefined;
    const money = formatKpi(cost, "money", { prefix: currencyPrefix(billing.currency) });
    return credits ? `${money} for ${formatKpi(credits, "whole")} credits` : money;
}

export function subscriptionText(count: number): string {
    return count === 1 ? "1 subscription" : `${formatKpi(count, "whole")} subscriptions`;
}
