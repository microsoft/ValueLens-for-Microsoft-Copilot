//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DestinationId, StageId } from "@/components/destinations";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import { DEPARTMENT_COLUMN } from "@/queries/executive";
import { joinNames } from "./executive-data";

/**
 * What needs attention: a handful of fixed rules over figures the other
 * destinations already show, each naming the decision it points to. The same
 * data always gives the same list, and no rule prints money.
 */

export type AttentionRule = "idle-seats" | "cowork-over-allowance" | "enablement-gap" | "weakest-theme";

/** Breaks ties in reach, so the order never depends on the order rows arrive in. */
export const RULE_ORDER: readonly AttentionRule[] = [
    "idle-seats",
    "cowork-over-allowance",
    "enablement-gap",
    "weakest-theme",
];

/** Idle seats are worth raising once they are this share of the estate. */
export const IDLE_SEAT_SHARE = 0.05;
/** Fewer departments than this have no meaningful bottom quarter. */
export const MIN_DEPARTMENTS = 4;
/** The share of departments counted as the bottom of the range. */
export const LOWER_QUARTILE = 0.25;
/** How much of the gap to the average enablement is assumed to close. */
export const GAP_CLOSED = 0.5;
/** A feedback theme needs this many ratings before its rate means anything. */
export const MIN_THEME_RATINGS = 20;

export interface AttentionItem {
    rule: AttentionRule;
    /** `negative` for something already going wrong; `caution` for an opportunity. */
    tone: "caution" | "negative";
    title: string;
    evidence: string;
    /** The seats, people or ratings it touches; the list leads with the largest. */
    reach: number;
    /** The size of it in a few words, for the chip beside the title. */
    stake: string;
    link: { destination: DestinationId; stage?: StageId; label: string };
}

export interface AttentionInputs {
    /** The executive summary, keyed by DAX name. */
    summary?: SummaryRow;
    /** The license roster by dormancy bucket, keyed by column name. */
    dormancy?: readonly SummaryRow[];
    /** The license estate, keyed by DAX name. */
    estate?: SummaryRow;
    /** The departments table, keyed by column name. */
    departments?: readonly SummaryRow[];
    /** Cowork's billing summary, keyed by DAX name. */
    cowork?: SummaryRow;
    /** Feedback by category, one row per category and rating, keyed by column name. */
    themes?: readonly SummaryRow[];
    /** What the org column calls its groups, plural: "departments". */
    orgPlural: string;
}

const wholePercent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

function plural(count: number, one: string, many: string): string {
    return count === 1 ? one : many;
}

function lowerFirst(text: string): string {
    return text.charAt(0).toLowerCase() + text.slice(1);
}

function idleSeats({ summary, dormancy, estate }: AttentionInputs): AttentionItem | undefined {
    // Unreconciled, every licensed person reads as never active, so idle seats can't be told apart.
    const usable = readNumber(estate, "[License Inventory Usable]");
    if (usable === undefined || usable === 0 || !dormancy) return undefined;

    const buckets = dormancy
        .map((row) => ({
            order: readNumber(row, "Dormancy Bucket Order"),
            name: readText(row, "Dormancy Bucket"),
            seats: readNumber(row, "Licensed Users") ?? 0,
        }))
        .filter((bucket) => bucket.order !== undefined && bucket.seats > 0);
    const total = buckets.reduce((sum, bucket) => sum + bucket.seats, 0);
    const idle = buckets
        .filter((bucket) => (bucket.order ?? 0) >= 2)
        .sort((a, b) => b.seats - a.seats || (a.order ?? 0) - (b.order ?? 0));
    const idleSeats = idle.reduce((sum, bucket) => sum + bucket.seats, 0);
    if (total <= 0 || idleSeats === 0 || idleSeats / total < IDLE_SEAT_SHARE) return undefined;

    const breakdown = joinNames(
        idle.map((bucket) => `${formatKpi(bucket.seats, "whole")} ${lowerFirst(bucket.name ?? "idle")}`),
    );
    const unlicensed = readNumber(summary, "[Unlicensed Users]") ?? 0;
    const demand =
        unlicensed > 0
            ? ` ${formatKpi(unlicensed, "whole")} ${plural(unlicensed, "person already uses", "people already use")} Copilot without a license.`
            : "";

    return {
        rule: "idle-seats",
        tone: "caution",
        title: `Reassign ${formatKpi(idleSeats, "whole")} idle ${plural(idleSeats, "seat", "seats")}`,
        evidence: `Licensed seats with no Copilot activity in 30 days or more: ${breakdown}.${demand}`,
        reach: idleSeats,
        stake: `${wholePercent.format(idleSeats / total)} of seats`,
        link: { destination: "readiness", stage: "license-readiness", label: "Open Readiness" },
    };
}

function coworkOverAllowance({ cowork }: AttentionInputs): AttentionItem | undefined {
    const share = readNumber(cowork, "[Users Over Limit]");
    const users = readNumber(cowork, "[Consuming Users]");
    if (share === undefined || users === undefined) return undefined;
    const over = Math.round(share * users);
    if (over < 1) return undefined;

    const period = readText(cowork, "[Period Label]");
    const policies = readNumber(cowork, "[Policies]") ?? 0;
    const across =
        policies > 0 ? `, across ${formatKpi(policies, "whole")} spending ${plural(policies, "policy", "policies")}` : "";

    return {
        rule: "cowork-over-allowance",
        tone: "negative",
        title: `${formatKpi(over, "whole")} ${plural(over, "person is", "people are")} over their Cowork allowance`,
        evidence: `${wholePercent.format(share)} of the ${formatKpi(users, "whole")} people using Cowork${period ? ` in ${period}` : ""} went past their spending policy's credit limit${across}.`,
        reach: over,
        stake: `${wholePercent.format(share)} of Cowork users`,
        link: { destination: "consumption", stage: "cowork-credits", label: "Open Consumption" },
    };
}

/** The value a quarter of the way up the sorted list, by nearest rank. */
export function lowerQuartile(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * LOWER_QUARTILE)];
}

function enablementGap({ departments, orgPlural }: AttentionInputs): AttentionItem | undefined {
    const rows = (departments ?? [])
        .map((row) => ({
            name: readText(row, DEPARTMENT_COLUMN),
            seats: readNumber(row, "Licensed Seats") ?? 0,
            hours: readNumber(row, "Hours Per Seat Month"),
            skills: readNumber(row, "Skills Per Person"),
        }))
        .filter(
            (row): row is { name: string; seats: number; hours: number; skills: number } =>
                row.name !== undefined && row.seats > 0 && row.hours !== undefined && row.skills !== undefined,
        );
    if (rows.length < MIN_DEPARTMENTS) return undefined;

    const hoursQuartile = lowerQuartile(rows.map((row) => row.hours)) ?? 0;
    const skillsQuartile = lowerQuartile(rows.map((row) => row.skills)) ?? 0;
    const seats = rows.reduce((sum, row) => sum + row.seats, 0);
    const average = rows.reduce((sum, row) => sum + row.hours * row.seats, 0) / seats;

    const behind = rows
        .filter((row) => row.hours <= hoursQuartile && row.skills <= skillsQuartile && row.hours < average)
        .sort((a, b) => a.hours - b.hours || a.name.localeCompare(b.name));
    // Expert hours a quarter if each closed part of its gap to the average hours per seat.
    const gain = behind.reduce((sum, row) => sum + GAP_CLOSED * (average - row.hours) * row.seats * 3, 0);
    if (behind.length === 0 || Math.round(gain) < 1) return undefined;

    const names = joinNames(behind.map((row) => row.name));
    const one = behind.length === 1;
    const reach = behind.reduce((sum, row) => sum + row.seats, 0);

    return {
        rule: "enablement-gap",
        tone: "caution",
        title: `Focus enablement on ${names}`,
        evidence: `${one ? "It is" : "They are"} in the bottom quarter of ${orgPlural} for both expert hours per seat and kinds of work per person. Closing half ${one ? "its" : "their"} gap to the average of ${formatKpi(average, "hours")} hours per seat a month would add about ${formatKpi(gain, "whole")} expert hours a quarter.`,
        reach,
        stake: `+${formatKpi(gain, "whole")} hours a quarter`,
        link: { destination: "adoption", label: "Open Adoption" },
    };
}

function weakestTheme({ summary, themes }: AttentionInputs): AttentionItem | undefined {
    const overall = readNumber(summary, "[Satisfaction]");
    if (overall === undefined || !themes) return undefined;

    const categories = new Map<string, { total: number; rate: number }>();
    for (const row of themes) {
        const name = readText(row, "Category");
        const total = readNumber(row, "Total Feedback");
        const rate = readNumber(row, "Satisfaction");
        if (name && total !== undefined && rate !== undefined && !categories.has(name)) {
            categories.set(name, { total, rate });
        }
    }

    const [weakest] = [...categories]
        .map(([name, theme]) => ({ name, ...theme }))
        .filter((theme) => theme.total >= MIN_THEME_RATINGS && theme.rate < overall)
        .sort((a, b) => a.rate - b.rate || b.total - a.total || a.name.localeCompare(b.name));
    if (!weakest) return undefined;
    const points = Math.round((overall - weakest.rate) * 100);
    if (points < 1) return undefined;

    return {
        rule: "weakest-theme",
        tone: "caution",
        title: `${weakest.name} is the least liked theme`,
        evidence: `${wholePercent.format(weakest.rate)} thumbs up across ${formatKpi(weakest.total, "whole")} ratings, against ${wholePercent.format(overall)} across all feedback.`,
        reach: weakest.total,
        stake: `${points} pp below overall`,
        link: { destination: "feedback", stage: "feedback", label: "Open Feedback" },
    };
}

const RULES: Record<AttentionRule, (inputs: AttentionInputs) => AttentionItem | undefined> = {
    "idle-seats": idleSeats,
    "cowork-over-allowance": coworkOverAllowance,
    "enablement-gap": enablementGap,
    "weakest-theme": weakestTheme,
};

/** The items that fire, the most seats, people or ratings first. */
export function attentionItems(inputs: AttentionInputs): AttentionItem[] {
    return RULE_ORDER.map((rule) => RULES[rule](inputs))
        .filter((item): item is AttentionItem => item !== undefined)
        .sort((a, b) => b.reach - a.reach || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
}
