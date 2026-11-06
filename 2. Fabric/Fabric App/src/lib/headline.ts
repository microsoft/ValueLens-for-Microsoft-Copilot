//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi, type KpiFormat } from "@/lib/format-kpi";

/** The model returns dates as ISO date-times; a period is read by its date part. */
function isoDate(value: unknown): string | undefined {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/**
 * One plain sentence above a chart, worked out from the rows it draws.
 *
 * Every builder here says what the data shows and nothing about why. Each
 * returns undefined rather than a sentence when the data is too thin to
 * say something true: no rows, a single category or period, a zero total,
 * or fewer people than `MIN_PEOPLE`.
 */
export type Headline = (table: DataTable) => string | undefined;

/** Below this many people a share or a ranking says more about individuals than a pattern. */
export const MIN_PEOPLE = 5;

/** A peak or a split needs at least this many periods to mean anything. */
export const MIN_PERIODS = 2;

const percent = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 0 });

function columnIndex(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A share as a whole percentage, never rounding a real part to 0% or a remainder to 100%. */
export function shareText(part: number, total: number): string {
    const share = part / total;
    if (share > 0 && share < 0.005) return "under 1%";
    if (share < 1 && share > 0.995) return "over 99%";
    return percent.format(share);
}

/** Totals a value column by a label column, skipping blank labels and values. */
export function totalsBy(table: DataTable, label: string, value: string): Map<string, number> {
    const totals = new Map<string, number>();
    const labelAt = columnIndex(table, label);
    const valueAt = columnIndex(table, value);
    if (labelAt < 0 || valueAt < 0) return totals;
    for (const row of table.rows) {
        const key = row[labelAt];
        const amount = finite(row[valueAt]);
        if (key === null || key === undefined || key === "" || amount === undefined) continue;
        const name = String(key);
        totals.set(name, (totals.get(name) ?? 0) + amount);
    }
    return totals;
}

export interface FigureOptions {
    format?: KpiFormat;
    prefix?: string;
}

function figure(value: number, options: FigureOptions): string {
    return formatKpi(value, options.format ?? "whole", { prefix: options.prefix });
}

export interface LeaderOptions extends FigureOptions {
    /** The category column, by its cleaned name. */
    label: string;
    /** The measure column, by its cleaned name. */
    value: string;
    /** What the value is, mid-sentence: "credits", "the cost". */
    of: string;
    /** When the categories are people, the fewest that can be ranked. */
    minCategories?: number;
}

/**
 * "Copilot Chat is the largest, at 62% of sessions." The largest category
 * and its share of the whole. Says nothing when there is only one category,
 * the total is not positive, or any value is negative.
 */
export function leaderHeadline(options: LeaderOptions): Headline {
    return (table) => {
        const totals = [...totalsBy(table, options.label, options.value)].filter(([, amount]) => amount !== 0);
        if (totals.length < Math.max(2, options.minCategories ?? 2)) return undefined;
        if (totals.some(([, amount]) => amount < 0)) return undefined;
        const total = totals.reduce((sum, [, amount]) => sum + amount, 0);
        if (total <= 0) return undefined;
        totals.sort((a, b) => b[1] - a[1]);
        const [name, amount] = totals[0];
        if (totals[1][1] === amount) return undefined;
        return `${name} is the largest, at ${shareText(amount, total)} of ${options.of}.`;
    };
}

export interface PeakOptions extends FigureOptions {
    /** The date column, by its cleaned name. */
    date: string;
    /** The measure column, summed per date. */
    value: string;
    /** What the value is, mid-sentence: "credits", "active users". */
    of: string;
    /** How each date reads: "the week of 5 May", "5 May", "May 2025". */
    period: "day" | "week" | "month";
}

function periodText(date: string, period: PeakOptions["period"]): string {
    const day = new Date(`${date}T00:00:00Z`);
    if (period === "month") return day.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const short = day.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return period === "week" ? `the week of ${short}` : short;
}

/**
 * "Credits peaked in the week of 5 May 2025, at 1,240." The highest period.
 * A peak, not a trend: the latest period may be partial, so it is never
 * compared with the one before it.
 */
export function peakHeadline(options: PeakOptions): Headline {
    return (table) => {
        const byDate = new Map<string, number>();
        const dateAt = columnIndex(table, options.date);
        const valueAt = columnIndex(table, options.value);
        if (dateAt < 0 || valueAt < 0) return undefined;
        for (const row of table.rows) {
            const date = isoDate(row[dateAt]);
            const amount = finite(row[valueAt]);
            if (!date || amount === undefined) continue;
            byDate.set(date, (byDate.get(date) ?? 0) + amount);
        }
        const dates = [...byDate].filter(([, amount]) => amount > 0);
        if (dates.length < MIN_PERIODS) return undefined;
        dates.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
        const [date, amount] = dates[0];
        const upper = options.of.charAt(0).toUpperCase() + options.of.slice(1);
        return `${upper} peaked ${options.period === "day" ? "on" : "in"} ${periodText(date, options.period)}, at ${figure(amount, options)}.`;
    };
}

export interface SplitOptions {
    /** The measure columns to compare, by cleaned name, with how each reads mid-sentence. */
    parts: readonly { column: string; label: string }[];
    /** What the parts add up to: "the cost", "credits". */
    of: string;
}

/**
 * "Prepaid covers 64% of the cost." The larger of two or more measure
 * columns, summed down the table, as a share of their total.
 */
export function splitHeadline(options: SplitOptions): Headline {
    return (table) => {
        const sums = options.parts.map((part) => {
            const at = columnIndex(table, part.column);
            const total = at < 0 ? 0 : table.rows.reduce((sum, row) => sum + (finite(row[at]) ?? 0), 0);
            return { label: part.label, total };
        });
        if (sums.some((part) => part.total < 0)) return undefined;
        const total = sums.reduce((sum, part) => sum + part.total, 0);
        if (total <= 0) return undefined;
        sums.sort((a, b) => b.total - a.total);
        const lead = sums[0];
        const upper = lead.label.charAt(0).toUpperCase() + lead.label.slice(1);
        return `${upper} ${lead.total === total ? "is all" : "makes up " + shareText(lead.total, total)} of ${options.of}.`;
    };
}

/** The first headline of several that has something to say. */
export function firstHeadline(...headlines: readonly Headline[]): Headline {
    return (table) => {
        for (const headline of headlines) {
            const text = headline(table);
            if (text) return text;
        }
        return undefined;
    };
}

/** Words that claim a cause. A headline describes the data; it never explains it. */
export const CAUSAL_WORDS = /\b(because|caused|causes|drove|drives|driven|due to|led to|leads to|resulted|results in|thanks to|boosted|impact)\b/i;
