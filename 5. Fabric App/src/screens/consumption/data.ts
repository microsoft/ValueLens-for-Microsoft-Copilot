//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { formatKpi } from "@/lib/format-kpi";
import { toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import { asNumber } from "@/lib/tree-grid";
import type { ConsumptionLens } from "@/queries/consumption";

export const SMALL = "text-[length:var(--text-200)] leading-200";
export const BODY = "text-[length:var(--text-300)] leading-300";

/** Copilot credits are priced in US dollars in the report's rate settings. */
export const CREDIT_CURRENCY = "$";

/** The report's paired Consumption and Cost pages, as one stage with a lens. */
export const LENSES: readonly { id: ConsumptionLens; label: string }[] = [
    { id: "consumption", label: "Consumption" },
    { id: "cost", label: "Cost" },
];

interface Source {
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

/** A Consumption Central query with the stage's own slicers applied, as a DataTable. */
export function useConsumptionTable(source: Source, extra: readonly string[] = []): TableResult {
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { extra });
    const table = useMemo(
        () => (result.data?.status === "success" ? toDataTable(result.data.table, source.columnMetadata) : undefined),
        [result.data, source.columnMetadata],
    );
    const error = result.data?.status === "error" ? result.data.error.message : undefined;
    return { table, error, isLoading: !table && !error, refetch: result.refetch };
}

export interface SummaryResult {
    row: SummaryRow | undefined;
    /** True once the query has answered, even with no rows. */
    loaded: boolean;
    error: string | undefined;
    refetch: () => void;
}

/** A one-row Consumption Central query, keyed by DAX column name. */
export function useConsumptionSummary(source: Source, extra: readonly string[] = []): SummaryResult {
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { extra });
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
