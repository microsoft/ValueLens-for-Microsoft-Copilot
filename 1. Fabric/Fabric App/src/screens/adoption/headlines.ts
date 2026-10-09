//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi } from "@/lib/format-kpi";
import { type Headline, MIN_PEOPLE, MIN_PERIODS, peakHeadline } from "@/lib/headline";
import type { AdoptionTrendMeasure } from "@/queries/adoption";
import { formatMonth } from "./habit-month";

const WEEK = "Chat + Agent Interactions (Audit Logs)WeekStart";
const MONTH = "Chat + Agent Interactions (Audit Logs)MonthStart";

function at(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The per-user trend lines, each with how it reads mid-sentence. */
export const PER_USER_SERIES = [
    { column: "Licensed", label: "licensed chat" },
    { column: "Unlicensed", label: "unlicensed chat" },
    { column: "Agents", label: "agents" },
] as const;

export type PerUserSeries = (typeof PER_USER_SERIES)[number]["column"];

/**
 * "Sessions per user are highest for licensed chat, at 3.20 a week against
 * 1.40 for agents." The surfaces' weekly averages side by side. A surface
 * used by fewer than `MIN_PEOPLE` people is left out, so a handful of
 * heavy users never reads as a pattern.
 */
export function perUserHeadline(users: Partial<Record<PerUserSeries, number | undefined>>): Headline {
    return (table) => {
        const weekAt = at(table, WEEK);
        if (weekAt < 0) return undefined;
        const averages = PER_USER_SERIES.flatMap((series) => {
            const people = users[series.column];
            const valueAt = at(table, series.column);
            if (people === undefined || people < MIN_PEOPLE || valueAt < 0) return [];
            const weekly = table.rows.map((row) => finite(row[valueAt])).filter((value) => value !== undefined);
            if (weekly.length < MIN_PERIODS) return [];
            return [{ label: series.label, average: weekly.reduce((sum, value) => sum + value, 0) / weekly.length }];
        });
        if (averages.length < 2 || averages.some((series) => series.average < 0)) return undefined;
        averages.sort((a, b) => b.average - a.average);
        const top = averages[0];
        const bottom = averages[averages.length - 1];
        const high = formatKpi(top.average, "rate");
        const low = formatKpi(bottom.average, "rate");
        if (top.average <= 0 || high === formatKpi(averages[1].average, "rate")) return undefined;
        return `Sessions per user are highest for ${top.label}, at ${high} a week against ${low} for ${bottom.label}. A comparison, not a cause.`;
    };
}

const SESSIONS_HEADLINE = peakHeadline({ date: WEEK, value: "All Sessions", of: "sessions", period: "week" });
const HOURS_HEADLINE = peakHeadline({
    date: WEEK,
    value: "Hours",
    of: "expert-equivalent hours",
    period: "week",
    format: "hours",
});

/** The weekly adoption trend's headline, following the measure it is drawn in. */
export function adoptionTrendHeadline(
    measure: AdoptionTrendMeasure,
    users: Partial<Record<PerUserSeries, number | undefined>>,
): Headline {
    if (measure === "sessions") return SESSIONS_HEADLINE;
    if (measure === "hours") return HOURS_HEADLINE;
    return perUserHeadline(users);
}

const percent = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** "4 - Power" reads as "Power". */
function stageName(value: unknown): string | undefined {
    if (typeof value !== "string" || value === "") return undefined;
    return value.replace(/^\d+\s*-\s*/, "");
}

/**
 * "The Power stage rose from 8% to 12% of users between January 2026 and
 * March 2026." The stage whose place in the mix moved most between the first
 * and last complete month, on the scale the chart is drawn in. Says nothing
 * when either month has fewer than `MIN_PEOPLE` users, no stage moved by a
 * whole point (or a whole user), or two stages moved by the same amount.
 */
export function habitMixHeadline(scale: "share" | "count"): Headline {
    return (table) => {
        const monthAt = at(table, MONTH);
        const stageAt = at(table, "Stage LegendStage");
        const usersAt = at(table, "Users");
        if (monthAt < 0 || stageAt < 0 || usersAt < 0) return undefined;
        const byMonth = new Map<string, Map<string, number>>();
        for (const row of table.rows) {
            const month = row[monthAt];
            const stage = stageName(row[stageAt]);
            const users = finite(row[usersAt]);
            if (typeof month !== "string" || !formatMonth(month) || !stage || users === undefined || users < 0) continue;
            const stages = byMonth.get(month) ?? new Map<string, number>();
            stages.set(stage, (stages.get(stage) ?? 0) + users);
            byMonth.set(month, stages);
        }
        const months = [...byMonth.keys()].sort();
        if (months.length < MIN_PERIODS) return undefined;
        const first = byMonth.get(months[0])!;
        const last = byMonth.get(months[months.length - 1])!;
        const firstTotal = [...first.values()].reduce((sum, users) => sum + users, 0);
        const lastTotal = [...last.values()].reduce((sum, users) => sum + users, 0);
        if (firstTotal < MIN_PEOPLE || lastTotal < MIN_PEOPLE) return undefined;

        const moves = [...new Set([...first.keys(), ...last.keys()])].map((stage) => {
            const from = first.get(stage) ?? 0;
            const to = last.get(stage) ?? 0;
            return scale === "share"
                ? { stage, from: from / firstTotal, to: to / lastTotal }
                : { stage, from, to };
        });
        moves.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
        const [top, next] = moves;
        const change = Math.abs(top.to - top.from);
        if (change < (scale === "share" ? 0.01 : 1)) return undefined;
        if (next && Math.abs(next.to - next.from) === change) return undefined;

        const show = (value: number) => (scale === "share" ? percent.format(value) : whole.format(value));
        if (show(top.from) === show(top.to)) return undefined;
        const unit = scale === "share" ? " of users" : " users";
        const direction = top.to > top.from ? "rose" : "fell";
        const span = `between ${formatMonth(months[0])} and ${formatMonth(months[months.length - 1])}`;
        return `The ${top.stage} stage ${direction} from ${show(top.from)} to ${show(top.to)}${unit} ${span}.`;
    };
}
