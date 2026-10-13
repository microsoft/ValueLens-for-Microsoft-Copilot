//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import statusQuery from "./shadow-ai-status.dax?raw";
import summaryQuery from "./shadow-ai-summary.dax?raw";
import toolsQuery from "./shadow-ai-tools.dax?raw";
import toolsSpec from "./shadow-ai-tools.json";

const summaryColumns: ColumnMetadataMap = {
    "[Tools Watched]": { name: "Tools Watched", displayName: "AI tools watched", format: FORMAT_WHOLE },
    "[Unsanctioned Tools]": { name: "Unsanctioned Tools", displayName: "Marked unsanctioned", format: FORMAT_WHOLE },
    "[Tools Found]": { name: "Tools Found", displayName: "Shadow AI tools found", format: FORMAT_WHOLE },
    "[Tools This Week]": { name: "Tools This Week", displayName: "Found this week", format: FORMAT_WHOLE },
    "[Devices]": { name: "Devices", displayName: "Devices", format: FORMAT_WHOLE },
    "[Users]": { name: "Users", displayName: "People", format: FORMAT_WHOLE },
    "[Cloud Users]": { name: "Cloud Users", displayName: "People (Cloud Discovery)", format: FORMAT_WHOLE },
    "[Status]": { name: "Status", displayName: "Status" },
};

const toolColumns: ColumnMetadataMap = {
    "[Tool]": { name: "Tool", displayName: "Tool" },
    "[Layer]": { name: "Layer", displayName: "Seen by" },
    "[Posture]": { name: "Posture", displayName: "Posture" },
    "[Devices]": { name: "Devices", displayName: "Devices", format: FORMAT_WHOLE },
    "[Users]": { name: "Users", displayName: "People", format: FORMAT_WHOLE },
};

const statusColumns: ColumnMetadataMap = {
    "[Probe]": { name: "Probe", displayName: "Probe" },
    "[Status]": { name: "Status", displayName: "Status" },
    "[Source]": { name: "Source", displayName: "Source" },
    "[Rows]": { name: "Rows", displayName: "Rows", format: FORMAT_WHOLE },
    "[Message]": { name: "Message", displayName: "Message" },
    "[Run At]": { name: "Run At", displayName: "Last run" },
};

/**
 * The shadow AI headline: how many watched AI tools not marked Sanctioned
 * Defender found, and on how many devices and people, from the measures the
 * installer adds. Every figure is a floor, not a census: Defender only sees
 * onboarded devices and the tools on the watchlist.
 */
export function shadowAiSummary() {
    return { connection, query: summaryQuery, columnMetadata: summaryColumns };
}

/**
 * Each watched AI tool not marked Sanctioned, by how Defender saw it over the
 * last 30 days: run on a device, reached over the network from one, installed,
 * or used in Cloud Discovery. One row per tool and layer.
 */
export function shadowAiTools() {
    return { connection, query: toolsQuery, columnMetadata: toolColumns, vegaLiteSpec: toolsSpec as VisualizationSpec };
}

/** One row per Defender probe on the last run, so the page can say what loaded and what was refused. */
export function shadowAiStatus() {
    return { connection, query: statusQuery, columnMetadata: statusColumns };
}

/** The postures a shadow AI tool can have; Sanctioned tools are not shadow AI, so the query leaves them out. */
export const SHADOW_AI_POSTURES = ["Unsanctioned", "Not reviewed"] as const;

export type ShadowAiLayer = "Ran" | "Network" | "Installed" | "Cloud Discovery";

export type ShadowAiProbe = "device_activity" | "installed" | "agents" | "cloud_discovery";

/** The ways Defender sees a tool, the probe that feeds each and the count that sizes its bars. */
export const SHADOW_AI_LAYERS: readonly {
    id: ShadowAiLayer;
    label: string;
    probe: ShadowAiProbe;
    measure: "Devices" | "Users";
    subtitle: string;
}[] = [
    {
        id: "Ran",
        label: "Ran",
        probe: "device_activity",
        measure: "Devices",
        subtitle: "Devices that ran each tool's app or process in the last 30 days",
    },
    {
        id: "Network",
        label: "Reached",
        probe: "device_activity",
        measure: "Devices",
        subtitle: "Devices that connected to each tool's web domains in the last 30 days",
    },
    {
        id: "Installed",
        label: "Installed",
        probe: "installed",
        measure: "Devices",
        subtitle: "Devices with each tool installed, from Defender Vulnerability Management",
    },
    {
        id: "Cloud Discovery",
        label: "Cloud Discovery",
        probe: "cloud_discovery",
        measure: "Users",
        subtitle: "People using each generative AI app in Defender for Cloud Apps over the last 30 days",
    },
];

/** What each probe reads, for the status note. */
export const PROBE_LABELS: Readonly<Record<ShadowAiProbe, string>> = {
    device_activity: "Device activity",
    installed: "Installed software",
    agents: "AI agents",
    cloud_discovery: "Cloud Discovery",
};

/** A probe status in plain words. */
export function describeProbeStatus(status: string): string {
    switch (status) {
        case "ok":
            return "Loaded";
        case "empty":
            return "Ran, nothing found";
        case "forbidden":
            return "No permission";
        case "unlicensed":
            return "Not licensed";
        default:
            return "Failed";
    }
}

export interface ProbeStatus {
    probe: string;
    status: string;
    message: string;
}

export type ShadowAiState =
    /** The status table is empty: the Defender source hasn't run. */
    | { kind: "notRun" }
    /** Every probe was refused or failed. */
    | { kind: "noAccess"; failing: readonly ProbeStatus[] }
    /** Some probes loaded and some didn't. */
    | { kind: "partial"; failing: readonly ProbeStatus[] }
    | { kind: "ok" };

const WORKING = new Set(["ok", "empty"]);

/** Reads the last run's probe statuses into one state for the page. */
export function readShadowAiState(table: DataTable | undefined): ShadowAiState | undefined {
    const probes = probeStatuses(table);
    if (!probes) return undefined;
    if (probes.length === 0) return { kind: "notRun" };
    const failing = probes.filter((probe) => !WORKING.has(probe.status));
    if (failing.length === probes.length) return { kind: "noAccess", failing };
    if (failing.length > 0) return { kind: "partial", failing };
    return { kind: "ok" };
}

/** The last run's probes, or undefined until the status query answers. */
export function probeStatuses(table: DataTable | undefined): ProbeStatus[] | undefined {
    if (!table) return undefined;
    const column = (name: string) => table.columns.findIndex((def) => def.name === name);
    const at = { probe: column("Probe"), status: column("Status"), message: column("Message") };
    if (at.probe < 0 || at.status < 0) return [];
    return table.rows.map((row) => ({
        probe: String(row[at.probe] ?? ""),
        status: String(row[at.status] ?? "").toLowerCase(),
        message: at.message < 0 ? "" : String(row[at.message] ?? ""),
    }));
}

/** True when the probe feeding a layer didn't load, so the toggle can say why that layer is empty. */
export function layerUnavailable(statuses: readonly ProbeStatus[] | undefined, layer: ShadowAiLayer): boolean {
    const probe = SHADOW_AI_LAYERS.find((entry) => entry.id === layer)?.probe;
    const found = statuses?.find((entry) => entry.probe === probe);
    return found !== undefined && !WORKING.has(found.status);
}

/** The tools seen in one layer, the busiest first. */
export function toolsForLayer(table: DataTable | undefined, layer: ShadowAiLayer): DataTable | undefined {
    if (!table) return undefined;
    const at = table.columns.findIndex((def) => def.name === "Layer");
    if (at < 0) return table;
    return { ...table, rows: table.rows.filter((row) => row[at] === layer) };
}

/** Sizes the bars by the layer's own count: devices for what ran on a device, people for Cloud Discovery. */
export function layerToolsSpec(baseSpec: VisualizationSpec, layer: ShadowAiLayer): VisualizationSpec {
    const measure = SHADOW_AI_LAYERS.find((entry) => entry.id === layer)?.measure ?? "Devices";
    const spec = structuredClone(baseSpec) as unknown as { encoding: { x: { field: string; title: string } } };
    spec.encoding.x.field = measure;
    spec.encoding.x.title = measure === "Users" ? "People" : "Devices";
    return spec as unknown as VisualizationSpec;
}
