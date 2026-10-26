//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { readNumber, type SummaryRow } from "@/lib/summary-row";
import { isMissingFromModelError } from "@/lib/model-errors";

/**
 * The optional installer modules that feed a whole page or section of the
 * ValueLens model. An install can leave any of them off, or tick one before
 * its first load has run, and the app then leaves out what would be blank.
 */
export type OptionalSource = "m365Activity" | "productFeedback" | "agentRegistry" | "defender" | "resourceGraph";

/**
 * - `checking`: the probe hasn't answered yet, so everything stays in view.
 * - `present`: the source has rows.
 * - `absent`: no rows, or a model too old to have the source at all.
 * - `notConfigured`: the installer says the admin left this module off.
 * - `unknown`: the probe failed for another reason, so nothing is hidden on its account.
 */
export type SourceState = "checking" | "present" | "absent" | "notConfigured" | "unknown";

export type SourceAvailability = Readonly<Record<OptionalSource, SourceState>>;

export const OPTIONAL_SOURCES: readonly OptionalSource[] = [
    "m365Activity",
    "productFeedback",
    "agentRegistry",
    "defender",
    "resourceGraph",
];

/**
 * One unfiltered row count per source. The registry is counted by the
 * model's own measure, as the Agent registry stage reports it. Defender is
 * counted by its status table, which holds a row per probe once the source
 * has run at all, even when every probe was refused. Resource Graph counts
 * agent configuration and Foundry resources together, since an identity may
 * be able to read only one of them.
 */
const SOURCE_COUNTS: Readonly<Record<OptionalSource, string>> = {
    m365Activity: "COUNTROWS('M365 Activity')",
    productFeedback: "COUNTROWS('ProductFeedback')",
    agentRegistry: "[Agent Registry Records]",
    defender: "COUNTROWS('Defender Status')",
    resourceGraph: "COUNTROWS('Agent Configuration') + COUNTROWS('Foundry Resources')",
};

/**
 * Each source's count as its own query, so a model missing one table still
 * answers for the others. Asked only when the merged probe fails.
 */
export const SOURCE_PROBES: Readonly<Record<OptionalSource, string>> = {
    m365Activity: `EVALUATE ROW("Rows", ${SOURCE_COUNTS.m365Activity})`,
    productFeedback: `EVALUATE ROW("Rows", ${SOURCE_COUNTS.productFeedback})`,
    agentRegistry: `EVALUATE ROW("Rows", ${SOURCE_COUNTS.agentRegistry})`,
    defender: `EVALUATE ROW("Rows", ${SOURCE_COUNTS.defender})`,
    resourceGraph: `EVALUATE ROW("Rows", ${SOURCE_COUNTS.resourceGraph})`,
};

/**
 * Every source's count in one query, one column per source named after it. A
 * model missing any of the tables fails the whole query, so the app then asks
 * {@link SOURCE_PROBES} one by one. Empty when no source is asked.
 */
export function mergedSourceProbe(sources: readonly OptionalSource[]): string {
    const asked = OPTIONAL_SOURCES.filter((source) => sources.includes(source));
    if (asked.length === 0) return "";
    return `EVALUATE ROW(\n${asked.map((source) => `    "${source}", ${SOURCE_COUNTS[source]}`).join(",\n")}\n)`;
}

/** Nothing hidden: for screens rendered outside the app, and installs whose probes can't run. */
export const ALL_UNKNOWN: SourceAvailability = {
    m365Activity: "unknown",
    productFeedback: "unknown",
    agentRegistry: "unknown",
    defender: "unknown",
    resourceGraph: "unknown",
};

/** Reads one probe's answer. */
export function readSourceState(result: { row?: SummaryRow; loaded: boolean; error?: string }): SourceState {
    if (result.error !== undefined) return isMissingFromModelError(result.error) ? "absent" : "unknown";
    if (!result.loaded) return "checking";
    return (readNumber(result.row, "[Rows]") ?? 0) > 0 ? "present" : "absent";
}

/** Reads one source's count out of the merged probe's row, as {@link readSourceState} reads its own probe. */
export function readMergedSourceState(row: SummaryRow | undefined, source: OptionalSource): SourceState {
    return (readNumber(row, `[${source}]`) ?? 0) > 0 ? "present" : "absent";
}

/** True once the source should be left out because it has no data or was not configured. */
export function isAbsent(sources: SourceAvailability, source: OptionalSource): boolean {
    return sources[source] === "absent" || sources[source] === "notConfigured";
}
