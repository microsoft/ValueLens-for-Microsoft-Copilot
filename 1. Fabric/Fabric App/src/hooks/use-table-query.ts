//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import type { FilterKey } from "@/lib/filters";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import { useFilteredQuery } from "./use-filtered-query";

export interface TableSource {
    connection: string;
    query: string;
    columnMetadata: ColumnMetadataMap;
}

export interface TableResult {
    table: DataTable | undefined;
    error: string | undefined;
    isLoading: boolean;
    refetch: () => void;
}

export interface SummaryResult {
    row: SummaryRow | undefined;
    /** True once the query has answered, even with no rows. */
    loaded: boolean;
    error: string | undefined;
    refetch: () => void;
}

/**
 * A query with the destination's filters and the caller's own `extra` DAX
 * filters applied, as a DataTable ready for a chart or grid. Filters in
 * `ignore` are left off, as for a model that has no column they could filter.
 */
export function useTableQuery(
    source: TableSource,
    extra: readonly string[] = [],
    ignore?: readonly FilterKey[],
): TableResult {
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { extra, ignore });
    const table = useMemo(
        () => (result.data?.status === "success" ? toDataTable(result.data.table, source.columnMetadata) : undefined),
        [result.data, source.columnMetadata],
    );
    const error = result.data?.status === "error" ? result.data.error.message : undefined;
    return { table, error, isLoading: !table && !error, refetch: result.refetch };
}

/** A one-row query, keyed by DAX column name. */
export function useSummaryQuery(
    source: { connection: string; query: string },
    extra: readonly string[] = [],
    ignore?: readonly FilterKey[],
): SummaryResult {
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { extra, ignore });
    const row = useMemo(
        () => (result.data?.status === "success" ? toSummaryRow(result.data.table) : undefined),
        [result.data],
    );
    return {
        row,
        loaded: result.data?.status === "success",
        error: result.data?.status === "error" ? result.data.error.message : undefined,
        refetch: result.refetch,
    };
}
