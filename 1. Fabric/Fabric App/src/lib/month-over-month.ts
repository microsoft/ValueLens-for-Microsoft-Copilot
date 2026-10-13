//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The month arithmetic behind the Executive summary: which six months its
 * trend shows, and which two months each card's arrow compares. Dates are
 * ISO `yyyy-mm-dd` strings throughout, read as UTC.
 */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How many months the trend always shows. */
export const TREND_MONTHS = 6;

/** The first day of the month an ISO date falls in. */
export function monthOf(iso: string): string {
    return `${iso.slice(0, 7)}-01`;
}

/** The first day of the month `count` months after (or before, if negative) a month. */
export function addMonths(month: string, count: number): string {
    const [year, index] = month.split("-").map(Number);
    const date = new Date(Date.UTC(year, index - 1 + count, 1));
    return date.toISOString().slice(0, 10);
}

/** How many days a month has. */
export function daysInMonth(month: string): number {
    const [year, index] = month.split("-").map(Number);
    return new Date(Date.UTC(year, index, 0)).getUTCDate();
}

/** The last day of a month. */
export function monthEnd(month: string): string {
    return `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** "Jun" */
export function shortMonth(month: string): string {
    return MONTH_NAMES[Number(month.slice(5, 7)) - 1];
}

export interface TrendWindow {
    /** First day of the oldest month shown. */
    from: string;
    /** Last date shown: the end of the date range. */
    to: string;
    /** The first day of each month shown, oldest first. */
    months: string[];
    /** The first day of the month the range starts in; earlier months are faded. */
    rangeMonth: string;
}

/**
 * The six months ending with the month the range ends in. The range's own
 * months read first; any before it give the trend its context.
 */
export function trendWindow(rangeStart: string, rangeEnd: string, length = TREND_MONTHS): TrendWindow {
    const last = monthOf(rangeEnd);
    const months = Array.from({ length }, (_, i) => addMonths(last, i - (length - 1)));
    return { from: months[0], to: rangeEnd, months, rangeMonth: monthOf(rangeStart) };
}

export interface MonthPair {
    /** The last month wholly inside the range. */
    current: string;
    /** The month before it, also wholly inside the range. */
    previous: string;
}

/**
 * The last full month in the range and the one before it, or nothing when
 * the range holds fewer than two full months: partial months would compare
 * unlike with unlike.
 */
export function monthOverMonth(rangeStart: string, rangeEnd: string): MonthPair | undefined {
    if (rangeEnd < rangeStart) return undefined;
    const endMonth = monthOf(rangeEnd);
    const current = monthEnd(endMonth) === rangeEnd ? endMonth : addMonths(endMonth, -1);
    const previous = addMonths(current, -1);
    return previous >= rangeStart ? { current, previous } : undefined;
}

/** How a card's figure moves between the two months. */
export type DeltaKind =
    /** A count over the month, compared per day so month lengths don't decide it. */
    | "volume"
    /** A share, compared in percentage points. */
    | "rate"
    /** An average per person, compared as a plain difference. */
    | "average";

export interface Delta {
    direction: "up" | "down" | "flat";
    /** The size of the change, without its sign: "17%", "3.2 pp", "0.4". */
    amount: string;
    /** What is compared: "Jun vs May, per day". */
    comparison: string;
}

const percent = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * The change between two months' figures, rounded the way the card prints
 * it, or nothing when either month has no figure to compare.
 */
export function monthDelta(
    kind: DeltaKind,
    pair: MonthPair,
    current: number | null | undefined,
    previous: number | null | undefined,
): Delta | undefined {
    if (!isNumber(current) || !isNumber(previous)) return undefined;

    const months = `${shortMonth(pair.current)} vs ${shortMonth(pair.previous)}`;
    let change: number;
    let amount: string;
    let comparison = months;

    if (kind === "volume") {
        if (previous <= 0) return undefined;
        const perDay = current / daysInMonth(pair.current);
        const before = previous / daysInMonth(pair.previous);
        change = perDay / before - 1;
        amount = percent.format(Math.abs(change));
        comparison = `${months}, per day`;
    } else if (kind === "rate") {
        change = (current - previous) * 100;
        amount = `${oneDecimal.format(Math.abs(change))} pp`;
    } else {
        change = current - previous;
        amount = oneDecimal.format(Math.abs(change));
    }

    // Judge the direction on what the card prints, so "0%" never has an arrow.
    const printsAsZero = /^0(\.0)?(%| pp)?$/.test(amount);
    const direction = printsAsZero ? "flat" : change > 0 ? "up" : "down";
    return { direction, amount: printsAsZero ? "No change" : amount, comparison };
}
