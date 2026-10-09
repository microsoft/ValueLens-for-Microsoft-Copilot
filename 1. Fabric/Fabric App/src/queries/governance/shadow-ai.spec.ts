//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { describe, expect, it } from "vitest";
import {
    describeProbeStatus,
    layerToolsSpec,
    layerUnavailable,
    probeStatuses,
    readShadowAiState,
    shadowAiTools,
    toolsForLayer,
} from "./shadow-ai";

function statusTable(rows: [string, string, string][]): DataTable {
    return {
        columns: ["Probe", "Status", "Source", "Rows", "Message", "Run At"].map((name) => ({ name })),
        rows: rows.map(([probe, status, message]) => [probe, status, "graph", 0, message, "2025-01-01"]),
    };
}

function toolTable(rows: [string, string, number, number | null][]): DataTable {
    return {
        columns: ["Tool", "Layer", "Posture", "Devices", "Users"].map((name) => ({ name })),
        rows: rows.map(([tool, layer, devices, users]) => [tool, layer, "Not reviewed", devices, users]),
    };
}

describe("readShadowAiState", () => {
    it("waits until the status query answers", () => {
        expect(readShadowAiState(undefined)).toBeUndefined();
    });

    it("says Defender hasn't run when there are no status rows", () => {
        expect(readShadowAiState(statusTable([]))).toEqual({ kind: "notRun" });
    });

    it("counts a probe that ran and found nothing as working", () => {
        const table = statusTable([
            ["device_activity", "ok", ""],
            ["installed", "empty", ""],
            ["agents", "ok", ""],
            ["cloud_discovery", "empty", ""],
        ]);
        expect(readShadowAiState(table)).toEqual({ kind: "ok" });
    });

    it("lists the probes that failed when only some loaded", () => {
        const table = statusTable([
            ["device_activity", "ok", ""],
            ["cloud_discovery", "Forbidden", "403"],
        ]);
        expect(readShadowAiState(table)).toEqual({
            kind: "partial",
            failing: [{ probe: "cloud_discovery", status: "forbidden", message: "403" }],
        });
    });

    it("says nothing loaded when every probe was refused or failed", () => {
        const table = statusTable([
            ["device_activity", "unlicensed", ""],
            ["cloud_discovery", "error", "timeout"],
        ]);
        expect(readShadowAiState(table)?.kind).toBe("noAccess");
    });

    it("treats a status table without the expected columns as not run", () => {
        expect(probeStatuses({ columns: [{ name: "Other" }], rows: [["x"]] })).toEqual([]);
    });
});

describe("describeProbeStatus", () => {
    it.each([
        ["ok", "Loaded"],
        ["empty", "Ran, nothing found"],
        ["forbidden", "No permission"],
        ["unlicensed", "Not licensed"],
        ["error", "Failed"],
        ["anything else", "Failed"],
    ])("describes %s as %s", (status, words) => {
        expect(describeProbeStatus(status)).toBe(words);
    });
});

describe("layerUnavailable", () => {
    const statuses = probeStatuses(
        statusTable([
            ["device_activity", "ok", ""],
            ["installed", "empty", ""],
            ["cloud_discovery", "forbidden", ""],
        ]),
    );

    it("flags a layer whose probe was refused", () => {
        expect(layerUnavailable(statuses, "Cloud Discovery")).toBe(true);
    });

    it("keeps layers whose probe loaded or found nothing", () => {
        expect(layerUnavailable(statuses, "Ran")).toBe(false);
        expect(layerUnavailable(statuses, "Network")).toBe(false);
        expect(layerUnavailable(statuses, "Installed")).toBe(false);
    });

    it("doesn't flag a layer before the statuses load", () => {
        expect(layerUnavailable(undefined, "Ran")).toBe(false);
    });
});

describe("toolsForLayer", () => {
    const table = toolTable([
        ["Tool A", "Ran", 12, 9],
        ["Tool B", "Network", 4, 3],
        ["Tool A", "Cloud Discovery", 0, 20],
    ]);

    it("keeps only the chosen layer's rows", () => {
        expect(toolsForLayer(table, "Ran")?.rows.map((row) => row[0])).toEqual(["Tool A"]);
        expect(toolsForLayer(table, "Cloud Discovery")?.rows).toHaveLength(1);
        expect(toolsForLayer(table, "Installed")?.rows).toHaveLength(0);
    });

    it("waits until the tools query answers", () => {
        expect(toolsForLayer(undefined, "Ran")).toBeUndefined();
    });
});

describe("layerToolsSpec", () => {
    const base = shadowAiTools().vegaLiteSpec;
    const xOf = (spec: unknown) => (spec as { encoding: { x: { field: string; title: string } } }).encoding.x;

    it("sizes device layers by devices", () => {
        expect(xOf(layerToolsSpec(base, "Ran"))).toMatchObject({ field: "Devices", title: "Devices" });
        expect(xOf(layerToolsSpec(base, "Installed"))).toMatchObject({ field: "Devices", title: "Devices" });
    });

    it("sizes Cloud Discovery by people", () => {
        expect(xOf(layerToolsSpec(base, "Cloud Discovery"))).toMatchObject({ field: "Users", title: "People" });
    });

    it("leaves the shared spec untouched", () => {
        layerToolsSpec(base, "Cloud Discovery");
        expect(xOf(shadowAiTools().vegaLiteSpec).field).toBe("Devices");
    });
});
