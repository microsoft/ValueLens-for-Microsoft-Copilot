//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { DailySpend, WeeklySpend } from "@/lib/budget-runway";
import { isoDate } from "@/queries/consumption";

function columnIndex(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

function numberAt(row: readonly unknown[], index: number): number | undefined {
    const value = index < 0 ? undefined : row[index];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Sums the cost columns into one figure per date. A date where every cost
 * column is BLANK is left out, so it reads as no data rather than as free.
 */
function costByDate(table: DataTable | undefined, dateColumn: string, costColumns: readonly string[]): Map<string, number> {
    const totals = new Map<string, number>();
    if (!table) return totals;
    const date = columnIndex(table, dateColumn);
    const costs = costColumns.map((name) => columnIndex(table, name));
    for (const row of table.rows) {
        const day = isoDate(row[date]);
        const values = costs.map((index) => numberAt(row, index)).filter((value): value is number => value !== undefined);
        if (!day || values.length === 0) continue;
        totals.set(day, (totals.get(day) ?? 0) + values.reduce((sum, value) => sum + value, 0));
    }
    return totals;
}

/** Copilot Studio's daily cost: prepaid plus pay-as-you-go. */
export function studioDailySpend(table: DataTable | undefined): DailySpend[] {
    return [...costByDate(table, "Usage Date", ["Prepaid Cost", "PAYG Cost"])].map(([date, cost]) => ({ date, cost }));
}

/** Cowork's weekly cost: prepaid plus pay-as-you-go, on the day each week starts. */
export function coworkWeeklySpend(table: DataTable | undefined): WeeklySpend[] {
    return [...costByDate(table, "Week Start", ["Prepaid Cost", "PAYG Cost"])].map(([start, cost]) => ({ start, cost }));
}

/** Azure's daily cost, with the components of each day added together. */
export function azureDailySpend(table: DataTable | undefined): DailySpend[] {
    return [...costByDate(table, "Usage Date", ["Cost"])].map(([date, cost]) => ({ date, cost }));
}

/** The earlier of two ISO dates, ignoring one that is missing. */
export function earlierDate(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
}
