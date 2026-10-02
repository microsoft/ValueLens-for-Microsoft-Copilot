//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    FEEDBACK_SURFACE_MIN_COUNT,
    feedbackCategory,
    feedbackComments,
    feedbackSummary,
    feedbackSurface,
    feedbackTrend,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import categoryRows from "./__fixtures__/feedback-category.rows.json";

const modules = [
    { name: "feedbackSummary", factory: feedbackSummary, columns: liveColumns.feedbackSummary },
    { name: "feedbackTrend", factory: feedbackTrend, columns: liveColumns.feedbackTrend },
    { name: "feedbackCategory", factory: feedbackCategory, columns: liveColumns.feedbackCategory },
    { name: "feedbackSurface", factory: feedbackSurface, columns: liveColumns.feedbackSurface },
    { name: "feedbackComments", factory: feedbackComments, columns: liveColumns.feedbackComments },
];

const specModules = [
    { name: "feedbackTrend", factory: feedbackTrend },
    { name: "feedbackCategory", factory: feedbackCategory },
    { name: "feedbackSurface", factory: feedbackSurface },
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

/** Every column a spec's own transforms add, such as a `toDate` result. */
function derivedFields(spec: unknown): string[] {
    const transforms = (spec as { transform?: { as?: unknown }[] }).transform ?? [];
    return transforms.flatMap((step) => (typeof step.as === "string" ? [step.as] : []));
}

describe("feedback query contract", () => {
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

    it("keeps the report's category exclusions", () => {
        const query = feedbackCategory().query;
        expect(query).toContain('"🧪 Testing"');
        expect(query).toContain('"❓ Uncategorized"');
    });

    it("declares and applies the same surface minimum sample size", () => {
        expect(FEEDBACK_SURFACE_MIN_COUNT).toBe(5);
        expect(feedbackSurface().query).toContain("[@Total] >= 5");
    });
});

describe("feedback spec field references", () => {
    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set([
            ...Object.values(columnMetadata).map((def) => def.name),
            ...derivedFields(vegaLiteSpec),
        ]);

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

describe("feedback category labels", () => {
    it("uses stripped topic names in chart fixtures", () => {
        for (const row of categoryRows as Record<string, unknown>[]) {
            expect([...String(row["[Category]"])].every((char) => char.charCodeAt(0) < 128)).toBe(true);
        }
    });
});
