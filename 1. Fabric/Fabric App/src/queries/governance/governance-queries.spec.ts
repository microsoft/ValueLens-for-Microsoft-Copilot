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
    OWNER_STATUSES,
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

const specModules = [
    { name: "governanceExposure", factory: () => governanceExposure() },
    { name: "governanceOwners", factory: () => governanceOwners() },
];

/** The labels the model's `Governance Flags` column joins with "; ". */
const FLAGS = ["Owner has left", "No owner on record", "Org-wide with org data", "Shared, no recorded use"];

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
    it.each(modules)("$name covers exactly the columns the query returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets the bound connection", ({ factory }) => {
        expect(factory().connection).toBe("vl");
    });

    it.each(modules)("$name ships a non-empty DAX query", ({ factory }) => {
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

    it("puts the most-flagged, most-used agents first", () => {
        expect(governanceReviewQueue().query.trim()).toMatch(/ORDER BY \[Flag Count\] DESC, \[Users\] DESC, \[Agent\] ASC$/);
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
