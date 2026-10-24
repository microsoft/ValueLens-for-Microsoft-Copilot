//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import type { FilterProfile, NotFiltered } from "@/lib/filter-profiles";
import type { FilterKey } from "@/lib/filters";
import { splitQueryParts } from "@/lib/query-parts";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import { useFilteredQuery } from "./use-filtered-query";

export interface TableSource {
    connection: string;
    query: string;
    columnMetadata: ColumnMetadataMap;
    /** How the query takes the filter bar, when not as its model's default. */
    filters?: FilterProfile;
    /** The page's first view waits on this query: on screen it goes ahead of the other queries waiting. */
    lead?: boolean;
    /** While the saved task times load, ask the query at the model's own minutes: see `FilteredQueryConfig.speculate`. */
    speculate?: boolean;
}

export interface TableResult {
    table: DataTable | undefined;
    error: string | undefined;
    isLoading: boolean;
    refetch: () => void;
    /** Active filters the query can't take, and why. */
    notFilteredBy?: readonly NotFiltered[];
}

export interface SummaryResult {
    row: SummaryRow | undefined;
    /** True once the query has answered, even with no rows. */
    loaded: boolean;
    error: string | undefined;
    /**
     * True while the query is asked again with its last answer still in `row`
     * or `error`, as after a filter changes: that answer may be for the
     * filters as they were.
     */
    refreshing?: boolean;
    refetch: () => void;
    /** Active filters the query can't take, and why. */
    notFilteredBy?: readonly NotFiltered[];
}

/**
 * A query with the destination's filters and the caller's own `extra` DAX
 * filters applied, as a DataTable ready for a chart or grid. Filters in
 * `ignore` are left off, as for a query that deliberately reads past them.
 */
export function useTableQuery(
    source: TableSource,
    extra: readonly string[] = [],
    ignore?: readonly FilterKey[],
): TableResult {
    const result = useFilteredQuery(
        {
            connection: source.connection,
            query: source.query,
            filters: source.filters,
            lead: source.lead,
            speculate: source.speculate,
            columnMetadata: source.columnMetadata,
        },
        { extra, ignore },
    );
    const table = useMemo(
        () =>
            result.data?.status === "success"
                ? toDataTable(result.data.table, result.columnMetadata ?? source.columnMetadata)
                : undefined,
        [result.data, result.columnMetadata, source.columnMetadata],
    );
    const error = result.data?.status === "error" ? result.data.error.message : undefined;
    return { table, error, isLoading: !table && !error, refetch: result.refetch, notFilteredBy: result.notFilteredBy };
}

/**
 * {@link useTableQuery} for a query that asks several tables at once, each
 * row naming its table in a `[Part]` column: one result for each of `parts`.
 * They load, fail and ask again together. Pass `parts` as a constant.
 */
export function useTablePartsQuery<P extends string>(
    source: TableSource,
    parts: readonly P[],
    extra: readonly string[] = [],
    ignore?: readonly FilterKey[],
): Record<P, TableResult> {
    const result = useFilteredQuery(
        {
            connection: source.connection,
            query: source.query,
            filters: source.filters,
            lead: source.lead,
            speculate: source.speculate,
            columnMetadata: source.columnMetadata,
        },
        { extra, ignore },
    );
    const tables = useMemo(() => {
        if (result.data?.status !== "success") return undefined;
        const split = splitQueryParts(result.data.table, parts);
        const columnMetadata = result.columnMetadata ?? source.columnMetadata;
        return new Map(parts.map((part) => [part, toDataTable(split[part], columnMetadata)]));
    }, [result.data, result.columnMetadata, parts, source.columnMetadata]);
    const error = result.data?.status === "error" ? result.data.error.message : undefined;
    const { refetch, notFilteredBy } = result;
    return useMemo(() => {
        const each = parts.map((part): [P, TableResult] => {
            const table = tables?.get(part);
            return [part, { table, error, isLoading: !table && !error, refetch, notFilteredBy }];
        });
        return Object.fromEntries(each) as Record<P, TableResult>;
    }, [parts, tables, error, refetch, notFilteredBy]);
}

/** A one-row query, keyed by DAX column name. */
export function useSummaryQuery(
    source: { connection: string; query: string; filters?: FilterProfile; lead?: boolean; speculate?: boolean },
    extra: readonly string[] = [],
    ignore?: readonly FilterKey[],
): SummaryResult {
    const result = useFilteredQuery(
        {
            connection: source.connection,
            query: source.query,
            filters: source.filters,
            lead: source.lead,
            speculate: source.speculate,
        },
        { extra, ignore },
    );
    const row = useMemo(
        () => (result.data?.status === "success" ? toSummaryRow(result.data.table) : undefined),
        [result.data],
    );
    return {
        row,
        loaded: result.data?.status === "success",
        error: result.data?.status === "error" ? result.data.error.message : undefined,
        refreshing: result.isRefreshing,
        refetch: result.refetch,
        notFilteredBy: result.notFilteredBy,
    };
}
