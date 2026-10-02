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
import { FILTER_KEYS } from "@/lib/filters";
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
 * A Consumption Central query with the stage's own slicers applied, as a
 * DataTable. The filter bar's are never applied: the model has none of the
 * columns they filter, so on a page that has a filter bar this reads the
 * whole of Consumption Central and the caller narrows it with `extra`.
 */
export function useConsumptionTable(source: TableSource, extra: readonly string[] = []): TableResult {
    const query = usePricedQuery(source.query);
    return useTableQuery(
        { connection: source.connection, query, columnMetadata: source.columnMetadata },
        extra,
        FILTER_KEYS,
    );
}

/** A one-row Consumption Central query, keyed by DAX column name, without the filter bar's filters. */
export function useConsumptionSummary(source: TableSource, extra: readonly string[] = []): SummaryResult {
    const query = usePricedQuery(source.query);
    return useSummaryQuery({ connection: source.connection, query }, extra, FILTER_KEYS);
}
