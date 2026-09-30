//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    licenseCandidates,
    licenseDemandSummary,
    licenseDormancy,
    licenseEstateSummary,
    licensePriorityByOrg,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import candidateRows from "./__fixtures__/license-candidates.rows.json";

type Row = Record<string, string | number | boolean | null>;

const modules = [
    { name: "licenseDemandSummary", factory: () => licenseDemandSummary(), columns: liveColumns.licenseDemandSummary },
    { name: "licenseEstateSummary", factory: () => licenseEstateSummary(), columns: liveColumns.licenseEstateSummary },
    { name: "licensePriorityByOrg", factory: () => licensePriorityByOrg(), columns: liveColumns.licensePriorityByOrg },
    { name: "licenseCandidates", factory: () => licenseCandidates(), columns: liveColumns.licenseCandidates },
    { name: "licenseDormancy", factory: () => licenseDormancy(), columns: liveColumns.licenseDormancy },
];

const specModules = [
    { name: "licensePriorityByOrg", factory: () => licensePriorityByOrg() },
    { name: "licenseDormancy", factory: () => licenseDormancy() },
];

/** Characters `ColumnDef.name` strips from the original DAX column name. */
function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

/** Every `field` reference anywhere in a Vega-Lite spec. */
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

describe("licensing query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        const { columnMetadata } = factory();
        expect(Object.keys(columnMetadata).sort()).toEqual([...columns].sort());
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

    it("ranks license candidates at user grain", () => {
        const { query } = licenseCandidates();
        const grouping = query.slice(query.indexOf("SUMMARIZECOLUMNS("), query.indexOf('"@Score"'));
        expect(grouping).toContain("[Audit_UserId]");
        expect(grouping).not.toContain("[Organization]");
        expect(query).toContain("LOOKUPVALUE(");
    });

    it("keeps dormancy ordered by the model bucket order", () => {
        const { query } = licenseDormancy();
        expect(query).toContain("'Copilot Licensed'[Dormancy Bucket Order]");
        expect(query).toContain("[Licensed Seats by Dormancy (Verified)]");
    });
});

describe("licensing spec field references", () => {
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

describe("license candidates", () => {
    it("arrives ranked, best candidate first", () => {
        const ranks = (candidateRows as Row[]).map((row) => row["[Rank]"] as number);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(ranks[0]).toBe(1);
    });
});
