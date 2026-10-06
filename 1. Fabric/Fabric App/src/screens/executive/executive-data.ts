//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { KpiDelta } from "@/components/kpi-card";
import {
    monthDelta,
    monthOverMonth,
    trendWindow,
    type DeltaKind,
    type MonthPair,
    type TrendWindow,
} from "@/lib/month-over-month";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";

/**
 * The arithmetic behind the Executive summary's cards, kept apart from the
 * components so it can be tested against the models' real answers.
 */

/** A DataTable's rows as objects keyed by column name, such as `record["Hours"]`. */
export function tableRecords(table: DataTable | undefined): SummaryRow[] {
    if (!table) return [];
    return table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]])));
}

/** `a / b`, or nothing when either is missing or `b` isn't positive. */
export function ratio(a: number | undefined, b: number | undefined): number | undefined {
    return a === undefined || b === undefined || b <= 0 ? undefined : a / b;
}

/** Adds the figures that are present, or nothing when none is. */
export function sumPresent(...values: (number | undefined)[]): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

export interface ExecutiveRange {
    /** The first day the cards cover: the range's start, or the first day with activity if that's later. */
    start: string;
    /** The last day the cards cover: the range's end, or the last day with activity if that's sooner. */
    end: string;
    /** The six months the trend shows. */
    window: TrendWindow;
    /** The two months the arrows compare, when the range holds two full months. */
    pair: MonthPair | undefined;
}

/**
 * The days the page covers. A range reaching past the activity is held to it,
 * so a month with no data at one end never counts as a full month to compare.
 */
export function executiveRange(
    from: string | undefined,
    to: string | undefined,
    firstDate: string | undefined,
    lastDate: string | undefined,
): ExecutiveRange | undefined {
    if (!firstDate || !lastDate) return undefined;
    const start = from && from > firstDate ? from : firstDate;
    const end = to && to < lastDate ? to : lastDate;
    if (end < start) return undefined;
    return { start, end, window: trendWindow(start, end), pair: monthOverMonth(start, end) };
}

/** Monthly rows by the first day of their month, `2026-06-01`. */
export function byMonth(records: readonly SummaryRow[]): Map<string, SummaryRow> {
    const months = new Map<string, SummaryRow>();
    for (const record of records) {
        const start = record["Month Start"];
        if (typeof start === "string") months.set(start.slice(0, 10), record);
    }
    return months;
}

/** A card's arrow from the monthly rows, or nothing when there aren't two full months to compare. */
export function cardDelta(
    kind: DeltaKind,
    pair: MonthPair | undefined,
    months: ReadonlyMap<string, SummaryRow>,
    read: (row: SummaryRow | undefined) => number | undefined,
    polarity?: KpiDelta["polarity"],
): KpiDelta | undefined {
    if (!pair) return undefined;
    const delta = monthDelta(kind, pair, read(months.get(pair.current)), read(months.get(pair.previous)));
    return delta && (polarity ? { ...delta, polarity } : delta);
}

/** The figures the cards work out from the one-row summary, keyed by DAX name. */
export interface WorkRates {
    /** Expert-equivalent minutes per person with a task, per week. */
    minutesPerPersonWeek: number | undefined;
    tasksPerPersonWeek: number | undefined;
    /** Expert-equivalent minutes per task. */
    minutesPerTask: number | undefined;
    /** Agents' share of the expert-equivalent hours. */
    agentShare: number | undefined;
    /** The habit ladder's top two rungs together. */
    habitRate: number | undefined;
}

export function workRates(summary: SummaryRow | undefined): WorkRates {
    const hours = readNumber(summary, "[Hours]");
    const tasks = readNumber(summary, "[Tasks]");
    const people = readNumber(summary, "[People]");
    const weeks = readNumber(summary, "[Weeks]");
    const personWeeks = people !== undefined && weeks !== undefined ? people * weeks : undefined;
    const minutes = hours === undefined ? undefined : hours * 60;
    const habitual = readNumber(summary, "[Habitual Pct]");
    const power = readNumber(summary, "[Power Pct]");
    return {
        minutesPerPersonWeek: ratio(minutes, personWeeks),
        tasksPerPersonWeek: ratio(tasks, personWeeks),
        minutesPerTask: ratio(minutes, tasks),
        agentShare: ratio(readNumber(summary, "[Agent Hours]"), hours),
        habitRate: habitual === undefined && power === undefined ? undefined : (habitual ?? 0) + (power ?? 0),
    };
}

const listFormat = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });

/** "A, B and C" */
export function joinNames(names: readonly string[]): string {
    return listFormat.format(names);
}

/** The agent with the most users, or every agent tied for it. */
export function mostUsedAgent(summary: SummaryRow | undefined): string | undefined {
    const names = (readText(summary, "[Agent With Most Users]") ?? "")
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean);
    if (names.length === 0) return undefined;
    return names.length === 1 ? names[0] : `${joinNames(names)}, tied on users`;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

/** "6 Jul 2026", from an ISO date or date-time; nothing for anything else. */
export function formatDay(value: unknown): string | undefined {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
    return dayFormat.format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/** "June", from an ISO date or date-time; nothing for anything else. */
export function formatMonth(value: unknown): string | undefined {
    if (typeof value !== "string" || !/^\d{4}-\d{2}/.test(value)) return undefined;
    return monthFormat.format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`));
}
