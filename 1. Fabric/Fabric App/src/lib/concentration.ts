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

export interface Concentration {
    total: number;
    /** People with a value above zero. */
    people: number;
    /** Only the slices that hold at least {@link MIN_PEOPLE} people. */
    slices: ConcentrationSlice[];
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

    const people = sorted.length;
    const cumulative: number[] = [];
    let running = 0;
    for (const value of sorted) {
        running += value;
        cumulative.push(running);
    }

    const slices = TOP_SLICES.map((pct) => {
        const size = Math.ceil(pct * people);
        return { pct, people: size, share: cumulative[size - 1] / total };
    }).filter((slice) => slice.people >= MIN_PEOPLE);

    return { total, people, slices, points: paretoPoints(cumulative, total) };
}

/** The curve from (0, 0) to (1, 1), thinned evenly but always keeping both ends. */
function paretoPoints(cumulative: readonly number[], total: number): ParetoPoint[] {
    const people = cumulative.length;
    const steps = Math.min(people, MAX_POINTS - 1);
    const points: ParetoPoint[] = [{ peopleShare: 0, totalShare: 0 }];
    let last = 0;
    for (let step = 1; step <= steps; step++) {
        const count = step === steps ? people : Math.round((step * people) / steps);
        if (count <= last) continue;
        last = count;
        points.push({ peopleShare: count / people, totalShare: cumulative[count - 1] / total });
    }
    return points;
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
export function concentrationHeadline(result: Concentration | undefined, noun: string): string | undefined {
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
