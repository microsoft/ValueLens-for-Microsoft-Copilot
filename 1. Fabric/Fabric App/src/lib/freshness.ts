//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DestinationId } from "@/components/destinations";

/** A source whose last loaded date a page can report. */
export type FreshnessSource =
    | "auditLog"
    | "m365Activity"
    | "productFeedback"
    | "agentRegistry"
    | "cowork"
    | "copilotStudio"
    | "azure"
    | "agentEvaluation";

export const FRESHNESS_LABELS: Readonly<Record<FreshnessSource, string>> = {
    auditLog: "Audit log",
    m365Activity: "Microsoft 365 activity",
    productFeedback: "Product feedback",
    agentRegistry: "Agent 365 registry",
    cowork: "Cowork",
    copilotStudio: "Copilot Studio",
    azure: "Azure",
    agentEvaluation: "Agent evaluation",
};

/** Sources that report by week, so their last date starts a week rather than ending one. */
const WEEKLY: ReadonlySet<FreshnessSource> = new Set(["cowork"]);

/** The sources each page draws on, in the order its label lists them. */
export const PAGE_SOURCES: Readonly<Record<DestinationId, readonly FreshnessSource[]>> = {
    executive: ["auditLog"],
    adoption: ["auditLog"],
    leaderboards: ["auditLog"],
    "work-patterns": ["m365Activity"],
    "agent-evaluation": ["agentEvaluation"],
    governance: ["agentRegistry"],
    readiness: ["auditLog"],
    consumption: ["cowork", "copilotStudio", "azure"],
    value: ["auditLog"],
    efficiency: ["auditLog"],
    feedback: ["productFeedback"],
    assumptions: [],
    appendix: [],
};

const sameYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const otherYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "7 Oct", or "7 Oct 2025" outside the current year; undefined for a blank or unreadable date. */
export function formatFreshnessDate(value: string | null | undefined, today: Date = new Date()): string | undefined {
    const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return undefined;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match[3])) return undefined;
    return (date.getUTCFullYear() === today.getUTCFullYear() ? sameYear : otherYear).format(date);
}

export type FreshnessDates = Partial<Record<FreshnessSource, string | null>>;

/**
 * "Audit log to 7 Oct · Copilot Studio to 6 Oct": each source with a date, in
 * the order given. Sources without one are left out; with none, undefined.
 */
export function describeFreshness(
    sources: readonly FreshnessSource[],
    dates: FreshnessDates,
    today: Date = new Date(),
): string | undefined {
    const parts = sources.flatMap((source) => {
        const date = formatFreshnessDate(dates[source], today);
        if (!date) return [];
        return [`${FRESHNESS_LABELS[source]} to ${WEEKLY.has(source) ? "week of " : ""}${date}`];
    });
    return parts.length > 0 ? parts.join(" · ") : undefined;
}
