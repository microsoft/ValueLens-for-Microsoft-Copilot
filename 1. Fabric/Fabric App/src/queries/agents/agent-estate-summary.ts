//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { readNumber, type SummaryRow } from "@/lib/summary-row";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./agent-estate-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Registry Agents]": { name: "Registry Agents", displayName: "Agents in the registry", format: FORMAT_WHOLE },
    "[Tenant Built]": { name: "Tenant Built", displayName: "Built in this tenant", format: FORMAT_WHOLE },
    "[Seen In Use]": { name: "Seen In Use", displayName: "Seen in use", format: FORMAT_WHOLE },
    "[Unmatched Sessions]": {
        name: "Unmatched Sessions",
        displayName: "Sessions outside the registry",
        format: FORMAT_WHOLE,
    },
    "[Registry Updated]": { name: "Registry Updated", displayName: "Registry updated" },
};

/**
 * The size of the agent estate, and how much of it the audit log can see.
 *
 * `Seen In Use` is defined here rather than read from the model's
 * `Agents With Observed Activity`. That measure counts distinct agent names
 * with sessions, and the blank name every unmatched session falls under is
 * one of them — so a tenant where no session matches the registry reports one
 * agent in use. Counting non-blank `Title ID` values, the key the audit log
 * joins on, gives the true figure, and the sessions that fell outside the
 * registry are reported separately instead of being hidden in that blank.
 */
export function agentEstateSummary() {
    return { connection, query, columnMetadata };
}

/** How far the audit log's agent sessions could be tied back to the registry. */
export type RegistryLinkage =
    | { kind: "unknown" }
    | { kind: "none"; unmatchedSessions: number; registryAgents: number }
    | { kind: "partial"; unmatchedSessions: number; seenInUse: number; registryAgents: number }
    | { kind: "complete"; seenInUse: number; registryAgents: number };

/**
 * Classifies the estate summary into the one linkage message the screen shows.
 *
 * A registry with no sessions to match is `unknown` rather than `complete` —
 * an empty audit log says nothing about whether the join works.
 */
export function describeRegistryLinkage(row: SummaryRow | undefined): RegistryLinkage {
    const registryAgents = readNumber(row, "[Registry Agents]");
    const seenInUse = readNumber(row, "[Seen In Use]") ?? 0;
    const unmatchedSessions = readNumber(row, "[Unmatched Sessions]") ?? 0;

    if (registryAgents === undefined) return { kind: "unknown" };
    if (unmatchedSessions > 0 && seenInUse === 0) {
        return { kind: "none", unmatchedSessions, registryAgents };
    }
    if (unmatchedSessions > 0) {
        return { kind: "partial", unmatchedSessions, seenInUse, registryAgents };
    }
    if (seenInUse > 0) return { kind: "complete", seenInUse, registryAgents };
    return { kind: "unknown" };
}
