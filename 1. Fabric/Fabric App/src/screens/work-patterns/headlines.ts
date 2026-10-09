//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { type Headline, MIN_PEOPLE, shareText } from "@/lib/headline";

function at(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface Reach {
    name: string;
    people: number;
    reach: number;
}

/** Rows with a name, a positive head count and a reach between 0 and 1. */
function reaches(table: DataTable, rows: readonly (readonly unknown[])[], label: string): Reach[] {
    const nameAt = at(table, label);
    const peopleAt = at(table, "People");
    const reachAt = at(table, table.columns.some((column) => column.name === "Reach") ? "Reach" : "Share");
    if (nameAt < 0 || peopleAt < 0 || reachAt < 0) return [];
    return rows.flatMap((row) => {
        const name = row[nameAt];
        const people = finite(row[peopleAt]);
        const reach = finite(row[reachAt]);
        if (typeof name !== "string" || name === "" || people === undefined || reach === undefined) return [];
        if (people <= 0 || reach <= 0 || reach > 1) return [];
        return [{ name, people, reach }];
    });
}

/**
 * The widest-reaching row, or undefined when fewer than two rows have any
 * reach, the people behind the shares number under `MIN_PEOPLE`, or the top
 * two round to the same share.
 */
function widest(items: Reach[]): { top: Reach; share: string } | undefined {
    if (items.length < 2) return undefined;
    // Reach is people over everyone active, so the active base is people / reach.
    const base = Math.max(...items.map((item) => item.people / item.reach));
    if (Math.round(base) < MIN_PEOPLE) return undefined;
    const sorted = [...items].sort((a, b) => b.reach - a.reach);
    const share = shareText(sorted[0].reach, 1);
    if (share === shareText(sorted[1].reach, 1)) return undefined;
    return { top: sorted[0], share };
}

/**
 * "Teams reaches the most people, at 97% of those active." For a chart of
 * reach by `label`, with People and Reach (or Share) columns.
 */
export function widestReachHeadline(label: string): Headline {
    return (table) => {
        const found = widest(reaches(table, table.rows as unknown[][], label));
        return found && `${found.top.name} reaches the most people, at ${found.share} of those active.`;
    };
}

/** "How far each workload reaches". */
export const WORKLOAD_REACH_HEADLINE = widestReachHeadline("Workload");

/** "Which apps people open". */
export const APP_REACH_HEADLINE = widestReachHeadline("App");

/** "Where people work from". */
export const PLATFORM_REACH_HEADLINE = widestReachHeadline("Platform");

function isoDate(value: unknown): string | undefined {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/**
 * "Which workloads people use, week by week": "In the week of 14 Sept 2026,
 * Teams reached the most people, at 94% of those active." Reads the latest
 * week on the chart.
 */
export const WORKLOAD_TREND_HEADLINE: Headline = (table) => {
    const dateAt = at(table, "Week Start");
    if (dateAt < 0) return undefined;
    const weeks = table.rows.map((row) => isoDate(row[dateAt])).filter((date): date is string => date !== undefined);
    if (weeks.length === 0) return undefined;
    const latest = weeks.reduce((a, b) => (b > a ? b : a));
    const found = widest(
        reaches(
            table,
            table.rows.filter((row) => isoDate(row[dateAt]) === latest),
            "Workload",
        ),
    );
    if (!found) return undefined;
    const week = new Date(`${latest}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });
    return `In the week of ${week}, ${found.top.name} reached the most people, at ${found.share} of those active.`;
};

const APP_COUNT = 6;

/**
 * "How much of the suite each person uses": "54% of active people opened 4
 * or more of the six apps." Picks the most apps that half or more of the
 * active people reach, so the sentence describes the typical person.
 */
export const SUITE_DEPTH_HEADLINE: Headline = (table) => {
    const appsAt = at(table, "Apps");
    const peopleAt = at(table, "People");
    if (appsAt < 0 || peopleAt < 0) return undefined;
    const buckets = table.rows.flatMap((row) => {
        const apps = finite(row[appsAt]);
        const people = finite(row[peopleAt]);
        if (apps === undefined || people === undefined || people <= 0 || apps < 0 || apps > APP_COUNT) return [];
        return [{ apps, people }];
    });
    if (buckets.length < 2) return undefined;
    const total = buckets.reduce((sum, bucket) => sum + bucket.people, 0);
    if (total < MIN_PEOPLE) return undefined;
    const reaching = (apps: number) => buckets.filter((bucket) => bucket.apps >= apps).reduce((sum, b) => sum + b.people, 0);
    let apps = APP_COUNT;
    while (apps > 1 && reaching(apps) / total < 0.5) apps -= 1;
    const share = shareText(reaching(apps), total);
    if (apps === APP_COUNT) return `${share} of active people opened all six apps.`;
    if (apps === 1) return `${share} of active people opened at least one of the six apps.`;
    return `${share} of active people opened ${apps} or more of the six apps.`;
};

const ratio = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * "A Copilot user's week, against everyone else's": "Chat messages show the
 * widest gap: Copilot users average 1.7× as many as everyone else. A
 * comparison, not a cause." The gap is measured either way, so 0.5× counts as wide as 2×. Says
 * nothing when either group has fewer than `MIN_PEOPLE` people, under two
 * metrics are shown, the widest gap rounds to 1.0× or two metrics tie for it.
 */
export function copilotGapHeadline(copilotPeople: number | undefined, otherPeople: number | undefined): Headline {
    return (table) => {
        if (copilotPeople === undefined || otherPeople === undefined) return undefined;
        if (copilotPeople < MIN_PEOPLE || otherPeople < MIN_PEOPLE) return undefined;
        const metricAt = at(table, "Metric");
        const indexAt = at(table, "Index");
        if (metricAt < 0 || indexAt < 0) return undefined;
        const gaps = table.rows.flatMap((row) => {
            const metric = row[metricAt];
            const index = finite(row[indexAt]);
            if (typeof metric !== "string" || metric === "" || index === undefined || index <= 0) return [];
            return [{ metric, index, gap: Math.abs(Math.log(index)) }];
        });
        if (gaps.length < 2) return undefined;
        gaps.sort((a, b) => b.gap - a.gap);
        const [widest, next] = gaps;
        const text = ratio.format(widest.index);
        if (text === ratio.format(1)) return undefined;
        if (Math.abs(widest.gap - next.gap) < 1e-9 || text === ratio.format(next.index)) return undefined;
        return `${widest.metric} show the widest gap: Copilot users average ${text}× as many as everyone else. A comparison, not a cause.`;
    };
}
