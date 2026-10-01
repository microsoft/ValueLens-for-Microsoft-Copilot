//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import {
    useSummaryQuery,
    useTableQuery,
    type SummaryResult,
    type TableResult,
    type TableSource,
} from "@/hooks/use-table-query";
import { formatKpi } from "@/lib/format-kpi";
import { asNumber } from "@/lib/tree-grid";
import { readsCommercialTerms, withCommercialTerms, type ConsumptionLens } from "@/queries/consumption";

export { BODY, SMALL } from "@/lib/type-scale";
export type { SummaryResult, TableResult } from "@/hooks/use-table-query";

/** Copilot credits are priced in US dollars in the report's rate settings. */
export const CREDIT_CURRENCY = "$";

/** The report's paired Consumption and Cost pages, as one stage with a lens. */
export const LENSES: readonly { id: ConsumptionLens; label: string }[] = [
    { id: "consumption", label: "Consumption" },
    { id: "cost", label: "Cost" },
];

/**
 * The query priced at the terms saved in the app. A query that shows a cost
 * waits, as an empty query, until those terms are known, so no figure is
 * shown at the model's price and then changes.
 */
function usePricedQuery(query: string): string {
    const { status, saved } = useCommercialTerms();
    return useMemo(() => {
        if (status === "loading" && readsCommercialTerms(query)) return "";
        return withCommercialTerms(query, saved ?? undefined);
    }, [query, status, saved]);
}

/** A Consumption Central query with the stage's own slicers applied, as a DataTable. */
export function useConsumptionTable(source: TableSource, extra: readonly string[] = []): TableResult {
    const query = usePricedQuery(source.query);
    return useTableQuery({ connection: source.connection, query, columnMetadata: source.columnMetadata }, extra);
}

/** A one-row Consumption Central query, keyed by DAX column name. */
export function useConsumptionSummary(source: TableSource, extra: readonly string[] = []): SummaryResult {
    const query = usePricedQuery(source.query);
    return useSummaryQuery({ connection: source.connection, query }, extra);
}

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
