//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { formatKpi } from "@/lib/format-kpi";
import { asNumber } from "@/lib/tree-grid";
import type { ConsumptionLens } from "@/queries/consumption";

export { BODY, SMALL } from "@/lib/type-scale";
export type { SummaryResult, TableResult } from "@/hooks/use-table-query";
export { useConsumptionSummary, useConsumptionTable } from "@/hooks/use-consumption-query";

/** Copilot credits are priced in US dollars in the report's rate settings. */
export const CREDIT_CURRENCY = "$";

/** The report's paired Consumption and Cost pages, as one stage with a lens. */
export const LENSES: readonly { id: ConsumptionLens; label: string }[] = [
    { id: "consumption", label: "Consumption" },
    { id: "cost", label: "Cost" },
];

/** Money with its cents, blank when the model returned BLANK. */
export function moneyCell(prefix: string): (value: unknown) => string | null {
    return (value) => {
        const n = asNumber(value);
        return n === undefined ? null : formatKpi(n, "money", { prefix });
    };
}

/** The model writes period labels to sit mid-sentence; standing alone they start with a capital. */
export function standalone(text: string | undefined): string | undefined {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
