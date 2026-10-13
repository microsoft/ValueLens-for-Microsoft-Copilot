//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { isMissingFromModelError } from "@/lib/model-errors";
import type { SourceState } from "@/lib/optional-sources";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./governance-resource-graph.dax?raw";

const whole = (name: string, displayName: string) => ({ name, displayName, format: FORMAT_WHOLE });

const columnMetadata: ColumnMetadataMap = {
    "[Configured Agents]": whole("Configured Agents", "Agents configured"),
    "[Matched Agents]": whole("Matched Agents", "Matched to the registry"),
    "[No Sign In]": whole("No Sign In", "No sign-in required"),
    "[No Sign In Configured]": whole("No Sign In Configured", "No sign-in required, any agent"),
    "[Web Search]": whole("Web Search", "Web search on"),
    "[Foundry Resources]": whole("Foundry Resources", "Foundry resources"),
    "[Foundry Public]": whole("Foundry Public", "Open to the public network"),
    "[Foundry Public Projects]": whole("Foundry Public Projects", "Projects open to the public network"),
    "[Agent Status]": { name: "Agent Status", displayName: "Agent inventory status" },
    "[Foundry Status]": { name: "Foundry Status", displayName: "Foundry status" },
};

/**
 * Agent configuration and Foundry resources from the Azure Resource Graph
 * load, each read at its latest snapshot, with the latest status of the two
 * probes that fill them. Its own query, so a model without these tables
 * leaves every other governance figure alone.
 */
export function governanceResourceGraph() {
    return { connection, query, columnMetadata };
}

/** The load's probe outcomes, as `Resource Graph Status` records them. */
export type ResourceGraphProbeStatus = "ok" | "empty" | "forbidden" | "error" | "skipped";

export type ResourceGraphView =
    | { kind: "loading" }
    | { kind: "notSetUp" }
    | { kind: "noData"; notes: readonly string[] }
    | { kind: "error"; message: string }
    | { kind: "ready"; agents: boolean; foundry: boolean; notes: readonly string[] };

export const RESOURCE_GRAPH_NOT_SET_UP = {
    title: "Azure Resource Graph isn't turned on",
    description:
        "Turn on Azure Resource Graph in the installer to see agent configuration, such as agents anyone can use without signing in or that search the web, and Foundry resources open to the public network. The figures fill in after the next load and model refresh.",
};

export const RESOURCE_GRAPH_NO_DATA = {
    title: "No Resource Graph data yet",
    description:
        "Azure Resource Graph is turned on, but no agent configuration or Foundry resources have loaded yet. Run the load, refresh the model, then reopen the app.",
};

export const AGENT_INVENTORY_FORBIDDEN =
    "The identity that runs the load can't read the Copilot Studio agent inventory. Give it an Entra role such as Global Reader or Power Platform Administrator, or set up the \"Analytics Hub - Agent inventory\" flow as a fallback, then run the load again.";

export const FOUNDRY_FORBIDDEN =
    "The identity that runs the load can't list Foundry resources. Give it Reader at the management group that holds your Azure subscriptions, then run the load again.";

const AGENT_INVENTORY_ERROR =
    "The last load couldn't read the Copilot Studio agent inventory. Check the load's log, then run it again.";

const FOUNDRY_ERROR = "The last load couldn't list Foundry resources. Check the load's log, then run it again.";

function probeStatus(row: SummaryRow | undefined, column: string): ResourceGraphProbeStatus | undefined {
    return readText(row, column)?.toLowerCase() as ResourceGraphProbeStatus | undefined;
}

/** What to say about each probe that couldn't read its source on the latest load. */
export function resourceGraphNotes(row: SummaryRow | undefined): string[] {
    const notes: string[] = [];
    const agents = probeStatus(row, "[Agent Status]");
    const foundry = probeStatus(row, "[Foundry Status]");
    if (agents === "forbidden") notes.push(AGENT_INVENTORY_FORBIDDEN);
    else if (agents === "error") notes.push(AGENT_INVENTORY_ERROR);
    if (foundry === "forbidden") notes.push(FOUNDRY_FORBIDDEN);
    else if (foundry === "error") notes.push(FOUNDRY_ERROR);
    return notes;
}

/**
 * Reads the Resource Graph summary into what the page should show. A model
 * without the tables, or an install that left the source off, reads as not
 * set up rather than as a fault.
 */
export function describeResourceGraph(
    result: { row?: SummaryRow; loaded: boolean; error?: string },
    source: SourceState,
): ResourceGraphView {
    if (source === "notConfigured") return { kind: "notSetUp" };
    if (result.error !== undefined) {
        return isMissingFromModelError(result.error) ? { kind: "notSetUp" } : { kind: "error", message: result.error };
    }
    if (!result.loaded) return { kind: "loading" };
    const notes = resourceGraphNotes(result.row);
    const agents = (readNumber(result.row, "[Configured Agents]") ?? 0) > 0;
    const foundry = (readNumber(result.row, "[Foundry Resources]") ?? 0) > 0;
    if (!agents && !foundry) return { kind: "noData", notes };
    return { kind: "ready", agents, foundry, notes };
}
