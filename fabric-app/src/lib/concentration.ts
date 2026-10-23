//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { MIN_PEOPLE, shareText } from "./headline";

/** The top slices of people the concentration figures report. */
export const TOP_SLICES = [0.01, 0.05, 0.25] as const;

/** At most this many points draw the Pareto curve; larger inputs are thinned. */
export const MAX_POINTS = 101;

export const PEOPLE_SHARE = "People Share";
export const TOTAL_SHARE = "Total Share";
export const EQUAL_SHARE = "Equal Share";

export interface ConcentrationSlice {
    /** The top fraction of people, such as 0.05 for the top 5%. */
    pct: number;
    /** How many people the slice holds. */
    people: number;
    /** Their share of the total, 0 to 1. */
    share: number;
}

export interface ParetoPoint {
    /** Cumulative share of people, largest first, 0 to 1. */
    peopleShare: number;
    /** Cumulative share of the total they account for, 0 to 1. */
    totalShare: number;
}

/** The share the top slices take, without the curve. */
export interface ConcentrationSlices {
    total: number;
    /** People with a value above zero. */
    people: number;
    /** Only the slices that hold at least {@link MIN_PEOPLE} people. */
    slices: ConcentrationSlice[];
}

export interface Concentration extends ConcentrationSlices {
    points: ParetoPoint[];
}

/**
 * How much of a total the busiest people account for, from one value per
 * person. People with nothing are left out, so the slices describe people
 * who took part. A slice is only reported once it holds enough people to
 * say something without pointing at an individual.
 */
export function concentration(values: readonly number[]): Concentration | undefined {
    const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    if (sorted.length === 0 || total <= 0) return undefined;

    const cumulative: number[] = [];
    let running = 0;
    for (const value of sorted) {
        running += value;
        cumulative.push(running);
    }
    return summarize(sorted.length, total, (count) => cumulative[count - 1]);
}

/**
 * The slices and curve from the number of people, their total and the sum of
 * the busiest `count` people's values, for whichever counts are needed.
 * Undefined when a needed sum is missing.
 */
function summarize(
    people: number,
    total: number,
    cumulativeAt: (count: number) => number | undefined,
): Concentration | undefined {
    const shares = topSlices(people, total, cumulativeAt);
    const points = shares && paretoPoints(people, total, cumulativeAt);
    return points && { ...shares, points };
}

/** The top slices alone, from the same inputs as {@link summarize}. Undefined when a slice's sum is missing. */
function topSlices(
    people: number,
    total: number,
    cumulativeAt: (count: number) => number | undefined,
): ConcentrationSlices | undefined {
    if (!Number.isSafeInteger(people) || people <= 0 || !Number.isFinite(total) || total <= 0) return undefined;

    const slices: ConcentrationSlice[] = [];
    for (const pct of TOP_SLICES) {
        // Integer percentages agree with DAX's integer cut arithmetic, including 0.05 * 140.
        const size = Math.ceil(((pct * 100) * people) / 100);
        const cumulative = cumulativeAt(size);
        if (cumulative === undefined) return undefined;
        if (size >= MIN_PEOPLE) slices.push({ pct, people: size, share: cumulative / total });
    }
    return { total, people, slices };
}

/** The curve from (0, 0) to (1, 1), thinned evenly but always keeping both ends. */
function paretoPoints(
    people: number,
    total: number,
    cumulativeAt: (count: number) => number | undefined,
): ParetoPoint[] | undefined {
    const steps = Math.min(people, MAX_POINTS - 1);
    const points: ParetoPoint[] = [{ peopleShare: 0, totalShare: 0 }];
    let last = 0;
    for (let step = 1; step <= steps; step++) {
        const count = step === steps ? people : Math.round((step * people) / steps);
        if (count <= last) continue;
        last = count;
        const cumulative = cumulativeAt(count);
        if (cumulative === undefined) return undefined;
        points.push({ peopleShare: count / people, totalShare: cumulative / total });
    }
    return points;
}

/** The columns of a concentration query's cut rows, as {@link readConcentration} and {@link readConcentrationSlices} read them. */
export const CUT_COUNT = "Count";
export const CUT_CUMULATIVE = "Cumulative";
export const CUT_PEOPLE = "People";
export const CUT_TOTAL = "Total";

/** A query's cut rows, checked: the sum of the busiest people's values by how many of them there are. */
interface Cuts {
    people: number;
    total: number;
    sums: Map<number, number>;
}

/**
 * The cut rows of a concentration query, undefined when there are none or
 * any is malformed: a count that isn't a whole number of people, a sum that
 * isn't positive, rows that disagree on the people or total, a sum above the
 * total or below a smaller cut's, or a cut of everyone that misses the total.
 * Rows without a count are skipped, so a query can return cut rows beside
 * others.
 */
function readCuts(table: DataTable | undefined): Cuts | undefined {
    if (!table) return undefined;
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [countAt, cumulativeAt, peopleAt, totalAt] = [CUT_COUNT, CUT_CUMULATIVE, CUT_PEOPLE, CUT_TOTAL].map(at);
    if ([countAt, cumulativeAt, peopleAt, totalAt].some((index) => index < 0)) return undefined;

    const sums = new Map<number, number>();
    let people = 0;
    let total = 0;
    for (const row of table.rows) {
        const [count, cumulative] = [row[countAt], row[cumulativeAt]];
        if (count === null || count === undefined) continue;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0 ||
            typeof cumulative !== "number" || !Number.isFinite(cumulative) || cumulative <= 0) return undefined;
        const rowPeople = row[peopleAt];
        const rowTotal = row[totalAt];
        if (typeof rowPeople !== "number" || !Number.isSafeInteger(rowPeople) || rowPeople < count ||
            typeof rowTotal !== "number" || !Number.isFinite(rowTotal) || rowTotal <= 0) return undefined;
        if (people && (rowPeople !== people || rowTotal !== total)) return undefined;
        if (sums.has(count) && sums.get(count) !== cumulative) return undefined;
        if (cumulative > rowTotal + Math.abs(rowTotal) * 1e-9) return undefined;
        sums.set(count, cumulative);
        people = rowPeople;
        total = rowTotal;
    }
    if (sums.size === 0) return undefined;
    const final = sums.get(people);
    if (final !== undefined && Math.abs(final - total) > Math.abs(total) * 1e-9) return undefined;
    let previous = 0;
    for (const [, sum] of [...sums].sort(([a], [b]) => a - b)) {
        if (sum < previous - Math.abs(total) * 1e-9) return undefined;
        previous = sum;
    }
    return { people, total, sums };
}

/**
 * The same figures as {@link concentration}, from a query that worked them
 * out in the model: one row per cut, with the cut's `Count` of busiest people
 * and the `Cumulative` sum of their values, and the `People` with a value
 * and their `Total` repeated on each. The query returns every count the
 * slices and curve need, including the cut of everyone, so no person's value
 * has to leave the model.
 */
export function readConcentration(table: DataTable | undefined): Concentration | undefined {
    const cuts = readCuts(table);
    if (!cuts?.sums.has(cuts.people)) return undefined;
    return summarize(cuts.people, cuts.total, (count) => cuts.sums.get(count));
}

/**
 * The top slices alone, from cut rows like {@link readConcentration}'s. The
 * rows need hold only the slices' counts, not the curve's, and each slice
 * comes out as {@link readConcentration} gives it for the same people.
 * Leaderboards reads its rows this way.
 */
export function readConcentrationSlices(table: DataTable | undefined): ConcentrationSlices | undefined {
    const cuts = readCuts(table);
    return cuts && topSlices(cuts.people, cuts.total, (count) => cuts.sums.get(count));
}

/** Distinguishes a broken aggregate response from a genuinely empty population. */
export function concentrationIncomplete(table: DataTable | undefined, summary: ConcentrationSlices | undefined): boolean {
    if (!table || summary || table.rows.length === 0) return false;
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    if ([CUT_COUNT, CUT_CUMULATIVE, CUT_PEOPLE, CUT_TOTAL].some((name) => at(name) < 0)) return true;
    // Habit rows can legitimately exist with no positive hours and thus no cuts.
    return table.rows.some((row) => row[at(CUT_COUNT)] != null ||
        Number(row[at(CUT_TOTAL)]) > 0 || Number(row[at("Hours")]) > 0 || at("Cohort") < 0);
}

/**
 * One total per person from a table's person rows, summing a person who
 * appears more than once. Rows marked by any of the `totalFlags` columns,
 * such as a rollup's group and grand totals, are skipped.
 */
export function personValues(
    table: DataTable | undefined,
    person: string,
    value: string,
    totalFlags: readonly string[] = [],
): number[] | undefined {
    if (!table) return undefined;
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const personAt = at(person);
    const valueAt = at(value);
    const flagsAt = totalFlags.map(at).filter((index) => index >= 0);
    if (personAt < 0 || valueAt < 0) return [];
    const totals = new Map<string, number>();
    for (const row of table.rows) {
        if (flagsAt.some((index) => row[index] === true)) continue;
        const amount = row[valueAt];
        if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
        const key = String(row[personAt] ?? "");
        totals.set(key, (totals.get(key) ?? 0) + amount);
    }
    return [...totals.values()];
}

/** "1%", "5%", "25%". */
export function sliceLabel(pct: number): string {
    return `${Math.round(pct * 100)}%`;
}

/**
 * One sentence on how concentrated the total is, such as "The top 5% of
 * people account for 38% of sessions." It prefers the 5% slice, then 25%,
 * then 1%, and says nothing when no slice holds enough people.
 */
export function concentrationHeadline(result: ConcentrationSlices | undefined, noun: string): string | undefined {
    if (!result) return undefined;
    const slice = [0.05, 0.25, 0.01]
        .map((pct) => result.slices.find((candidate) => candidate.pct === pct))
        .find((candidate) => candidate !== undefined);
    if (!slice) return undefined;
    return `The top ${sliceLabel(slice.pct)} of people account for ${shareText(slice.share, 1)} of ${noun}.`;
}

/** The Pareto curve as a table for {@link paretoSpec}, with the equal-share diagonal alongside. */
export function paretoTable(result: Concentration | undefined): DataTable {
    const columns = [PEOPLE_SHARE, TOTAL_SHARE, EQUAL_SHARE].map((name) => ({
        name,
        displayName: name,
        format: "0%",
    }));
    const rows = (result?.points ?? []).map((point) => [point.peopleShare, point.totalShare, point.peopleShare]);
    return { columns, rows } as unknown as DataTable;
}

/**
 * The Pareto curve: the cumulative share of the total against the cumulative
 * share of people, busiest first, over a dashed line where everyone takes an
 * equal share. The further the curve bows above the line, the more the total
 * sits with a few people.
 */
export function paretoSpec(noun: string): VisualizationSpec {
    const label = `Share of ${noun}`;
    return {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        width: "container",
        height: "container",
        transform: [{ fold: [TOTAL_SHARE, EQUAL_SHARE], as: ["Series", "Share"] }],
        encoding: {
            x: {
                field: PEOPLE_SHARE,
                type: "quantitative",
                title: "Share of people, busiest first",
                scale: { domain: [0, 1] },
                axis: { format: ".0%" },
            },
            y: {
                field: "Share",
                type: "quantitative",
                title: label,
                scale: { domain: [0, 1] },
                axis: { format: ".0%" },
            },
            color: {
                field: "Series",
                type: "nominal",
                title: null,
                sort: [TOTAL_SHARE, EQUAL_SHARE],
                scale: { domain: [TOTAL_SHARE, EQUAL_SHARE] },
                legend: {
                    orient: "top",
                    direction: "horizontal",
                    labelExpr: `datum.value === '${EQUAL_SHARE}' ? 'Equal share' : '${label}'`,
                },
            },
            strokeDash: {
                field: "Series",
                type: "nominal",
                scale: { domain: [TOTAL_SHARE, EQUAL_SHARE], range: [[1, 0], [4, 4]] },
                legend: null,
            },
        },
        layer: [
            { mark: { type: "line", strokeWidth: 2 } },
            {
                transform: [{ filter: `datum.Series === '${TOTAL_SHARE}'` }],
                mark: { type: "point", filled: true, size: 30, opacity: 0 },
                encoding: {
                    tooltip: [
                        { field: PEOPLE_SHARE, type: "quantitative", title: "Top share of people", format: ".0%" },
                        { field: "Share", type: "quantitative", title: label, format: ".0%" },
                    ],
                },
            },
        ],
    } as unknown as VisualizationSpec;
}
