//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";

/**
 * An AI model name spelled the way OpenAI writes it. Consumption Central used
 * to title-case the words of each Azure meter, giving "Gpt 4O", "O4 Mini" and
 * a bare "5.4"; models loaded before the template fix still carry those names.
 * GPT names become "GPT-4o" and "GPT-5.4", o-series names "o4-mini", and
 * anything else, such as "Pay As You Go Copilot Credit", is left alone.
 */
export function modelDisplayName(name: string): string {
    const words = name.trim().toLowerCase().split(/[\s_-]+/).filter(Boolean);
    const [first, ...rest] = words;
    if (first === undefined) return name;
    if (first === "gpt") return ["GPT", ...rest].join("-");
    if (/^\d/.test(first)) return ["GPT", ...words].join("-");
    if (/^o\d/.test(first)) return words.join("-");
    return name;
}

/** The table with every text value in `column` passed through {@link modelDisplayName}. */
export function withModelNames(table: DataTable | undefined, column: string): DataTable | undefined {
    const index = table?.columns.findIndex((def) => def.name === column) ?? -1;
    if (!table || index < 0) return table;
    return {
        ...table,
        rows: table.rows.map((row) =>
            typeof row[index] === "string"
                ? row.map((value, i) => (i === index ? modelDisplayName(value as string) : value))
                : row,
        ),
    };
}
