//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { readNumber, type SummaryRow } from "@/lib/summary-row";

/**
 * The optional installer modules that feed a whole page or section of the
 * ValueLens model. An install can leave any of them off, or tick one before
 * its first load has run, and the app then leaves out what would be blank.
 */
export type OptionalSource = "m365Activity" | "productFeedback" | "agentRegistry";

/**
 * - `checking`: the probe hasn't answered yet, so everything stays in view.
 * - `present`: the source has rows.
 * - `absent`: no rows, or a model too old to have the source at all.
 * - `unknown`: the probe failed for another reason, so nothing is hidden on its account.
 */
export type SourceState = "checking" | "present" | "absent" | "unknown";

export type SourceAvailability = Readonly<Record<OptionalSource, SourceState>>;

export const OPTIONAL_SOURCES: readonly OptionalSource[] = ["m365Activity", "productFeedback", "agentRegistry"];

/**
 * One unfiltered row count per source, each its own query so a model missing
 * one table still answers for the others. The registry is counted by the
 * model's own measure, as the Agent registry stage reports it.
 */
export const SOURCE_PROBES: Readonly<Record<OptionalSource, string>> = {
    m365Activity: `EVALUATE ROW("Rows", COUNTROWS('M365 Activity'))`,
    productFeedback: `EVALUATE ROW("Rows", COUNTROWS('ProductFeedback'))`,
    agentRegistry: `EVALUATE ROW("Rows", [Agent Registry Records])`,
};

/** What the engine says when a query names a table or measure the model doesn't have. */
const MISSING_FROM_MODEL =
    /cannot find table|failed to resolve name|'[^']+'(?:\[[^\]]+\])? (?:was not found|cannot be found|does not exist)/i;

/** Nothing hidden: for screens rendered outside the app, and installs whose probes can't run. */
export const ALL_UNKNOWN: SourceAvailability = {
    m365Activity: "unknown",
    productFeedback: "unknown",
    agentRegistry: "unknown",
};

/** Reads one probe's answer. */
export function readSourceState(result: { row?: SummaryRow; loaded: boolean; error?: string }): SourceState {
    if (result.error !== undefined) return MISSING_FROM_MODEL.test(result.error) ? "absent" : "unknown";
    if (!result.loaded) return "checking";
    return (readNumber(result.row, "[Rows]") ?? 0) > 0 ? "present" : "absent";
}

/** True only once the probe has answered that the source has no data. */
export function isAbsent(sources: SourceAvailability, source: OptionalSource): boolean {
    return sources[source] === "absent";
}
