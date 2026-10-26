//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";

/**
 * How many rows a capped list would have held: the `Total` column it repeats
 * on every row. Undefined when the column is missing or no row came back.
 */
export function listTotal(table: DataTable | undefined, column = "Total"): number | undefined {
    if (!table) return undefined;
    const index = table.columns.findIndex((def) => def.name === column);
    if (index < 0) return undefined;
    let total: number | undefined;
    for (const row of table.rows) {
        const value = row[index];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
        if (total !== undefined && total !== value) return undefined;
        total = value;
    }
    return total;
}

/** The person or item rows of a rollup, leaving out its group and grand total rows. */
export function leafCount(table: DataTable, groupTotalFlag = "Is Group Total"): number {
    const index = table.columns.findIndex((def) => def.name === groupTotalFlag);
    return index < 0 ? table.rows.length : table.rows.filter((row) => row[index] !== true).length;
}

/** A required whole-list count. Missing metadata must never imply a complete list. */
export function listCount(table: DataTable, column = "Total"): number | undefined {
    if (table.rows.length === 0) return 0;
    const total = listTotal(table, column);
    return total !== undefined && total >= table.rows.length ? total : undefined;
}