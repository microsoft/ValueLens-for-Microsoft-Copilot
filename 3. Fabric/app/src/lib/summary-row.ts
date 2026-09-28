//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";

/** A single-row `ROW()` result, addressed by the DAX column name. */
export type SummaryRow = Record<string, unknown>;

/**
 * Collapses a one-row query result into a plain object keyed by the original
 * DAX column name, e.g. `row["[Licensed Active]"]`.
 *
 * Returns `undefined` when the query came back with no rows, which callers
 * should treat as an empty state rather than as zeroes.
 */
export function toSummaryRow(table: QueryTable): SummaryRow | undefined {
    const [row] = table.rows;
    if (!row) return undefined;

    const summary: SummaryRow = {};
    table.columns.forEach((column, index) => {
        summary[column.name] = row[index];
    });
    return summary;
}

/** Reads a numeric cell, mapping BLANK and non-numeric values to `undefined`. */
export function readNumber(row: SummaryRow | undefined, column: string): number | undefined {
    const value = row?.[column];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads a text cell, mapping BLANK and empty strings to `undefined`. */
export function readText(row: SummaryRow | undefined, column: string): string | undefined {
    const value = row?.[column];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
