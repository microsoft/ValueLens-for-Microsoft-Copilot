//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";

/** The column in which a query that asks several tables at once names each row's table. */
export const PART_COLUMN = "[Part]";

/**
 * Splits the answer of a query that asks several tables at once into one
 * table for each of `parts`, by its `[Part]` column, which they leave out.
 * A part with no rows gets an empty table, and so does every part of an
 * answer with no rows, which may not name its columns at all.
 */
export function splitQueryParts<P extends string>(table: QueryTable, parts: readonly P[]): Record<P, QueryTable> {
    const index = table.columns.findIndex((column) => column.name === PART_COLUMN);
    const columns = table.columns.filter((_, i) => i !== index);
    const rows = new Map<unknown, unknown[][]>(parts.map((part) => [part, []]));
    if (index !== -1) {
        for (const row of table.rows) rows.get(row[index])?.push(row.filter((_, i) => i !== index));
    }
    return Object.fromEntries(parts.map((part) => [part, { columns, rows: rows.get(part) ?? [] }])) as Record<P, QueryTable>;
}
