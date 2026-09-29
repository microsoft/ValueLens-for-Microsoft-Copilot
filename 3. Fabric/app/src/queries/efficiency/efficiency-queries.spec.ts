//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    deriveModelFitVerdict,
    modelFitByOrganization,
    modelFitByPerson,
    modelFitByTask,
    modelFitSummary,
    modelMatchByTool,
    modelUsage,
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "modelFitSummary", factory: () => modelFitSummary(), columns: liveColumns.modelFitSummary },
    { name: "modelUsage", factory: () => modelUsage(), columns: liveColumns.modelUsage },
    { name: "modelMatchByTool", factory: () => modelMatchByTool(), columns: liveColumns.modelMatchByTool },
    { name: "modelFitByTask", factory: () => modelFitByTask(), columns: liveColumns.modelFitByTask },
    { name: "modelFitByOrganization", factory: () => modelFitByOrganization(), columns: liveColumns.modelFitByOrganization },
    { name: "modelFitByPerson", factory: () => modelFitByPerson(), columns: liveColumns.modelFitByPerson },
];

const specModules = [
    { name: "modelUsage", factory: () => modelUsage() },
    { name: "modelMatchByTool", factory: () => modelMatchByTool() },
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

describe("efficiency query contract", () => {
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

    it("queries each verdict grouping directly instead of relying on the field parameter", () => {
        expect(modelFitByTask().query).toContain("[Task Breakdown Group]");
        expect(modelFitByOrganization().query).toContain("[Organization]");
        expect(modelFitByPerson().query).toContain("[Audit_UserId]");
        expect(modelFitByTask().query).not.toContain("'Model Fit View'");
    });
});

describe("efficiency spec field references", () => {
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

describe("model fit verdicts", () => {
    it("returns not enough data below five judged sessions", () => {
        expect(deriveModelFitVerdict({ judgedSessions: 4, overSpecifiedSessions: 4, underSpecifiedSessions: 0 })).toBe(
            "Not enough data",
        );
    });

    it("treats blank over and under counts as a well-matched segment", () => {
        expect(
            deriveModelFitVerdict({
                judgedSessions: 12,
                overSpecifiedSessions: null,
                underSpecifiedSessions: undefined,
            }),
        ).toBe("Well matched");
    });

    it("uses the largest exception bucket when the segment is not well matched", () => {
        expect(deriveModelFitVerdict({ judgedSessions: 12, overSpecifiedSessions: 7, underSpecifiedSessions: 1 })).toBe(
            "Over-specified",
        );
        expect(deriveModelFitVerdict({ judgedSessions: 12, overSpecifiedSessions: 2, underSpecifiedSessions: 6 })).toBe(
            "Under-specified",
        );
    });
});
