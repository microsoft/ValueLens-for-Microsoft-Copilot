//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi } from "@/lib/format-kpi";

/** How many categories a ranked chart shows, so a large tenant's 120 organizations stay readable. */
export const TOP_N = 15;

export interface TopOptions {
    /** The column that names each category. */
    label: string;
    /** The measure that ranks categories, summed over each category's rows. */
    by: string;
    /** How many categories to keep. */
    n?: number;
}

export interface Top {
    /** The kept rows, largest category first, then any Other rows. */
    table: DataTable;
    /** Categories kept. */
    shown: number;
    /** Categories in the full result. */
    of: number;
}

export interface OtherOptions extends TopOptions {
    /** Columns that add up across categories; Other holds their sums. Every other column except `label` splits Other, as a week would. */
    sum: readonly string[];
    /** The Other row's label, given how many categories it holds. */
    other: (count: number) => string;
}

/** Where the column called `name` is, or -1 when the table has none. */
function columnAt(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

/**
 * The table as it came, when a column it's ranked by isn't in it: every row,
 * with nothing said to be left out, rather than a page that fails. It warns,
 * naming the column, so a column named wrongly still shows.
 */
function unranked(table: DataTable, label: number, missing: string): Top {
    console.warn(`[top-n] Column "${missing}" was not found, so the table is shown unranked.`);
    const count = label < 0 ? table.rows.length : new Set(table.rows.map((row) => row[label])).size;
    return { table, shown: count, of: count };
}

function amount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Category names, largest first by `by`, ties by name. */
function ranked(table: DataTable, label: number, by: number): unknown[] {
    const totals = new Map<unknown, number>();
    for (const row of table.rows) totals.set(row[label], (totals.get(row[label]) ?? 0) + amount(row[by]));
    return [...totals]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([name]) => name);
}

/**
 * No categories, without looking up a column. On Azure the model's JSON answer
 * names its columns only in its rows, so a query with no rows has no columns either.
 */
function nothingToRank(table: DataTable): Top {
    return { table: { ...table, rows: [] }, shown: 0, of: 0 };
}

/** Rows of the kept categories, largest first, each category's rows in their original order. */
function keptRows(table: DataTable, label: number, kept: readonly unknown[]): unknown[][] {
    const order = new Map(kept.map((name, index) => [name, index]));
    return table.rows
        .map((row, index) => ({ row, index, rank: order.get(row[label]) }))
        .filter((entry): entry is typeof entry & { rank: number } => entry.rank !== undefined)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.row);
}

/** The `n` largest categories by `by`. For rates, where an Other row would average away its meaning. */
export function topRows(table: DataTable, { label, by, n = TOP_N }: TopOptions): Top {
    if (table.rows.length === 0) return nothingToRank(table);
    const labelAt = columnAt(table, label);
    const byAt = columnAt(table, by);
    if (labelAt < 0 || byAt < 0) return unranked(table, labelAt, labelAt < 0 ? label : by);
    const names = ranked(table, labelAt, byAt);
    const kept = names.slice(0, n);
    return { table: { ...table, rows: keptRows(table, labelAt, kept) }, shown: kept.length, of: names.length };
}

/**
 * The `n` largest categories by `by`, and the rest folded into one Other row
 * (one per key, such as a week) whose `sum` columns add up the folded rows,
 * so the chart still covers everyone in the result.
 */
export function topWithOther(table: DataTable, { label, by, n = TOP_N, sum, other }: OtherOptions): Top {
    if (table.rows.length === 0) return nothingToRank(table);
    const labelAt = columnAt(table, label);
    const byAt = columnAt(table, by);
    if (labelAt < 0 || byAt < 0) return unranked(table, labelAt, labelAt < 0 ? label : by);
    const names = ranked(table, labelAt, byAt);
    if (names.length <= n) return { table: { ...table, rows: keptRows(table, labelAt, names) }, shown: names.length, of: names.length };

    const missing = sum.find((column) => columnAt(table, column) < 0);
    if (missing !== undefined) return unranked(table, labelAt, missing);
    const kept = names.slice(0, n);
    const keep = new Set(kept);
    const summed = new Set(sum.map((column) => columnAt(table, column)));
    const name = other(names.length - n);
    const folded = new Map<string, unknown[]>();
    for (const row of table.rows) {
        if (keep.has(row[labelAt])) continue;
        const key = JSON.stringify(row.filter((_, index) => index !== labelAt && !summed.has(index)));
        const into = folded.get(key);
        if (!into) {
            folded.set(key, row.map((value, index) => (index === labelAt ? name : summed.has(index) ? (value ?? null) : value)));
            continue;
        }
        for (const index of summed) {
            if (row[index] === null || row[index] === undefined) continue;
            into[index] = amount(into[index]) + amount(row[index]);
        }
    }
    return { table: { ...table, rows: [...keptRows(table, labelAt, kept), ...folded.values()] }, shown: kept.length, of: names.length };
}

/** "Top 15 of 120 organizations by active users", or nothing when every category is shown. */
export function topNote(top: Pick<Top, "shown" | "of">, plural: string, by: string): string | undefined {
    return top.shown < top.of ? `Top ${top.shown} of ${formatKpi(top.of, "whole")} ${plural} by ${by}` : undefined;
}
