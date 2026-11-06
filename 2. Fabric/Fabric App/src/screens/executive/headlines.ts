//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { peakHeadline, type Headline } from "@/lib/headline";
import { largestHeadline } from "@/screens/value/headlines";

/**
 * Reads a headline from the table with one more column, `total`, adding up
 * `parts` row by row. A row with none of the parts gets no total.
 */
export function withTotal(parts: readonly string[], total: string, headline: Headline): Headline {
    return (table) => {
        const at = parts.map((part) => table.columns.findIndex((column) => column.name === part));
        if (at.every((i) => i < 0)) return undefined;
        const rows = table.rows.map((row) => {
            const values = at.map((i) => (i < 0 ? undefined : row[i])).filter(
                (value): value is number => typeof value === "number" && Number.isFinite(value),
            );
            return [...row, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
        });
        return headline({ ...table, columns: [...table.columns, { name: total, displayName: total }], rows });
    };
}

/** "Work delivered by month": the busiest month for expert-equivalent hours. */
export const HOURS_HEADLINE = peakHeadline({
    date: "Month Start",
    value: "Hours",
    of: "expert-equivalent hours",
    period: "month",
    format: "hours",
});

/** "Credits consumed by month": the month Copilot Studio and Cowork used the most credits between them. */
export const CREDITS_HEADLINE = withTotal(
    ["Studio Credits", "Cowork Credits"],
    "Credits",
    peakHeadline({ date: "Month Start", value: "Credits", of: "credits", period: "month" }),
);

/** "What the work is": the kind of work with the most expert-equivalent hours. */
export const WORK_KINDS_HEADLINE = largestHeadline({
    label: "Chat + Agent Interactions (Audit Logs)Task Breakdown Category",
    value: "Hours",
    of: "expert-equivalent hours",
    format: "hours",
});
