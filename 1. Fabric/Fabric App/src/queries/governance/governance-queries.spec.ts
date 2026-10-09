//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    governanceExposure,
    governanceOwners,
    governanceReviewQueue,
    governanceSummary,
    shadowAiStatus,
    shadowAiSummary,
    shadowAiTools,
    FLAG_WEIGHTS,
    OWNER_STATUSES,
    SHADOW_AI_LAYERS,
    SHADOW_AI_POSTURES,
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "governanceSummary", factory: () => governanceSummary(), columns: liveColumns.governanceSummary },
    { name: "governanceExposure", factory: () => governanceExposure(), columns: liveColumns.governanceExposure },
    { name: "governanceOwners", factory: () => governanceOwners(), columns: liveColumns.governanceOwners },
    {
        name: "governanceReviewQueue",
        factory: () => governanceReviewQueue(),
        columns: liveColumns.governanceReviewQueue,
    },
];

/**
 * Shadow AI reads Defender's own tables, which the agent-type slicer doesn't
 * touch, so these share the column contract but not the slicer check.
 */
const shadowModules = [
    { name: "shadowAiSummary", factory: () => shadowAiSummary(), columns: liveColumns.shadowAiSummary },
    { name: "shadowAiTools", factory: () => shadowAiTools(), columns: liveColumns.shadowAiTools },
    { name: "shadowAiStatus", factory: () => shadowAiStatus(), columns: liveColumns.shadowAiStatus },
];

const specModules = [
    { name: "governanceExposure", factory: () => governanceExposure() },
    { name: "governanceOwners", factory: () => governanceOwners() },
    { name: "shadowAiTools", factory: () => shadowAiTools() },
];

/** The labels the model's `Governance Flags` column joins with "; ". */
const FLAGS = ["No sign-in required", "Owner has left", "No owner on record", "Org-wide with org data", "Shared, no recorded use"];

function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

function collectFields(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach((item) => collectFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "field" && typeof value === "string") {
                found.add(value);
            } else {
                collectFields(value, found);
            }
        }
    }
    return found;
}

describe("governance query contract", () => {
    it.each([...modules, ...shadowModules])("$name covers exactly the columns the query returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each([...modules, ...shadowModules])("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each([...modules, ...shadowModules])("$name targets the bound connection", ({ factory }) => {
        expect(factory().connection).toBe("vl");
    });

    it.each([...modules, ...shadowModules])("$name ships a non-empty DAX query", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
    });

    // FILTER over the table, never ALL or REMOVEFILTERS, so the agent-type
    // slicer still narrows every governance figure.
    it.each(modules)("$name keeps the agent-type filter", ({ factory }) => {
        expect(factory().query).not.toMatch(/\b(ALL|REMOVEFILTERS|ALLEXCEPT)\s*\(/);
    });
});

describe("governance flags", () => {
    const summary = governanceSummary().query;

    it("counts every flag the model raises, by its exact label", () => {
        for (const flag of FLAGS) expect(summary).toContain(`"${flag}"`);
    });

    it("lists only flagged agents in the review queue", () => {
        expect(governanceReviewQueue().query).toMatch(/FILTER\(\s*'Agents 365',\s*NOT ISBLANK\('Agents 365'\[Governance Flags\]\)\s*\)/);
    });

    it("puts the highest-priority, then most-flagged, most-used agents first", () => {
        expect(governanceReviewQueue().query.trim()).toMatch(
            /ORDER BY \[Priority\] DESC, \[Flag Count\] DESC, \[Users\] DESC, \[Agent\] ASC$/,
        );
    });

    it("weighs every flag, by its exact label, as FLAG_WEIGHTS says", () => {
        const queue = governanceReviewQueue().query;
        expect(Object.keys(FLAG_WEIGHTS).sort()).toEqual([...FLAGS].sort());
        for (const [flag, weight] of Object.entries(FLAG_WEIGHTS)) {
            expect(queue).toContain(`CONTAINSSTRING('Agents 365'[Governance Flags], "${flag}"), ${weight})`);
        }
    });

    it.each([
        ["exposure", governanceExposure().query],
        ["owners", governanceOwners().query],
    ])("leaves blocked and catalogue agents out of the %s chart", (_, query) => {
        expect(query).toContain("'Agents 365'[Created in]");
        expect(query).toContain("'Agents 365'[Is Blocked]");
    });

    it("emits every owner status the chart colours", () => {
        for (const status of OWNER_STATUSES) expect(governanceOwners().query).toContain(`"${status}"`);
    });
});

describe("shadow AI queries", () => {
    it("reads the headline from the measures the installer adds", () => {
        const query = shadowAiSummary().query;
        for (const measure of [
            "AI Tools Watched",
            "Unsanctioned AI Tools",
            "Shadow AI Tools Found",
            "Shadow AI Tools This Week",
            "Shadow AI Devices",
            "Shadow AI Users",
            "Shadow AI Users (Cloud Discovery)",
            "Shadow AI Status",
        ]) {
            expect(query).toContain(`[${measure}]`);
        }
    });

    it("emits every layer the toggle offers, defaults unlisted tools and leaves Sanctioned ones out", () => {
        const query = shadowAiTools().query;
        // Ran and Network come from the daily table's own Layer column.
        expect(query).toContain("'Shadow AI Daily'[Layer]");
        for (const layer of SHADOW_AI_LAYERS.filter((entry) => entry.probe !== "device_activity")) {
            expect(query).toContain(`"Layer", "${layer.id}"`);
        }
        // Posture comes from the watchlist; a tool missing from it defaults to the last posture.
        expect(query).toContain(`"${SHADOW_AI_POSTURES[SHADOW_AI_POSTURES.length - 1]}"`);
        expect(query).toMatch(/\[Posture\]\s*<>\s*"Sanctioned"/);
    });

    it("reads only the last run's probe statuses", () => {
        expect(shadowAiStatus().query).toContain("'Defender Status'");
        expect(shadowAiStatus().query).toMatch(/MAX\(\s*'Defender Status'\[RunAt\]\s*\)/);
    });
});

describe("governance spec field references", () => {
    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));
        for (const field of collectFields(vegaLiteSpec)) {
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it.each(specModules)("$name leaves no unsubstituted placeholders", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/__[A-Z]+__/);
    });

    it.each(specModules)("$name never relies on timeUnit to parse dates", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/"timeUnit"/);
    });
});
