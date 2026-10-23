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
    useTablePartsQuery,
    useTableQuery,
    type SummaryResult,
    type TableResult,
    type TableSource,
} from "@/hooks/use-table-query";
import { CONSUMPTION_METADATA } from "@/lib/filter-profiles";
import type { FilterKey } from "@/lib/filters";
import { readsCommercialTerms, withCommercialTerms } from "@/queries/consumption/commercial-terms";

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

/**
 * A Consumption Central query with the stage's own slicers (`extra`) and
 * the filter bar applied, as a DataTable. The filter bar reaches it through
 * the source's filter profile — the date on the reporting dates, an org on
 * the people Consumption Central holds that attribute for, an agent on the
 * agent bridge — and a source without one takes none of it. Filters in
 * `ignore` are left off where the caller already narrows by them.
 */
export function useConsumptionTable(
    source: TableSource,
    extra: readonly string[] = [],
    ignore: readonly FilterKey[] = [],
): TableResult {
    const query = usePricedQuery(source.query);
    return useTableQuery(
        {
            connection: source.connection,
            query,
            columnMetadata: source.columnMetadata,
            filters: source.filters ?? CONSUMPTION_METADATA,
        },
        extra,
        ignore,
    );
}

/** {@link useConsumptionTable} for a query that asks several tables at once, as {@link useTablePartsQuery} splits them. */
export function useConsumptionTableParts<P extends string>(
    source: TableSource,
    parts: readonly P[],
    extra: readonly string[] = [],
    ignore: readonly FilterKey[] = [],
): Record<P, TableResult> {
    const query = usePricedQuery(source.query);
    return useTablePartsQuery(
        {
            connection: source.connection,
            query,
            columnMetadata: source.columnMetadata,
            filters: source.filters ?? CONSUMPTION_METADATA,
        },
        parts,
        extra,
        ignore,
    );
}

/** A one-row Consumption Central query, keyed by DAX column name, filtered as {@link useConsumptionTable}. */
export function useConsumptionSummary(
    source: TableSource,
    extra: readonly string[] = [],
    ignore: readonly FilterKey[] = [],
): SummaryResult {
    const query = usePricedQuery(source.query);
    return useSummaryQuery(
        { connection: source.connection, query, filters: source.filters ?? CONSUMPTION_METADATA },
        extra,
        ignore,
    );
}
