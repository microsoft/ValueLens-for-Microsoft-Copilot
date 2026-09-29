//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    activationByOrg,
    activationSummary,
    adoptionSummary,
    adoptionTrend,
    habitSummary,
    habitTrend,
    trendHeatmap,
    trendHeatmapHeadline,
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "activationSummary", factory: activationSummary, columns: liveColumns.activationSummary },
    { name: "activationByOrg", factory: activationByOrg, columns: liveColumns.activationByOrg },
    { name: "adoptionSummary", factory: adoptionSummary, columns: liveColumns.adoptionSummary },
    { name: "adoptionTrend", factory: adoptionTrend, columns: liveColumns.adoptionTrend },
    { name: "habitSummary", factory: habitSummary, columns: liveColumns.habitSummary },
    { name: "habitTrend", factory: habitTrend, columns: liveColumns.habitTrend },
    { name: "trendHeatmap", factory: trendHeatmap, columns: liveColumns.trendHeatmap },
    { name: "trendHeatmapHeadline", factory: trendHeatmapHeadline, columns: liveColumns.trendHeatmapHeadline },
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
            } else if (key === "fold" && Array.isArray(value)) {
                value.forEach((item) => typeof item === "string" && found.add(item));
            } else {
                collectFields(value, found);
            }
        }
    }
    return found;
}

/** Names a spec's own transforms introduce, which never come from the query. */
function collectDerivedFields(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach((item) => collectDerivedFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "as") {
                if (typeof value === "string") found.add(value);
                if (Array.isArray(value)) {
                    value.forEach((item) => typeof item === "string" && found.add(item));
                }
            } else {
                collectDerivedFields(value, found);
            }
        }
    }
    return found;
}

describe("adoption query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        const { columnMetadata } = factory();
        expect(Object.keys(columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        const { columnMetadata } = factory();
        for (const [original, def] of Object.entries(columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets the bound connection", ({ factory }) => {
        expect(factory().connection).toBe("vl");
    });

    it.each(modules)("$name ships a non-empty DAX query", ({ factory }) => {
        const raw = factory().query;
        // `trim()` treats U+FEFF as whitespace, so the BOM has to be checked on
        // the raw string — it survives Vite's ?raw import and would otherwise be
        // sent to the query service as part of the statement.
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
        expect(raw).toContain("EVALUATE");
    });
});

describe("adoption spec field references", () => {
    const specModules = [
        { name: "activationByOrg", factory: () => activationByOrg({ cohort: "licensed" }) },
        { name: "activationByOrg (agents)", factory: () => activationByOrg({ cohort: "agents" }) },
        { name: "adoptionTrend", factory: () => adoptionTrend() },
        { name: "adoptionTrend (hours)", factory: () => adoptionTrend({ measure: "hours" }) },
        { name: "habitTrend", factory: () => habitTrend() },
        { name: "habitTrend (count)", factory: () => habitTrend({ scale: "count" }) },
        { name: "trendHeatmap", factory: () => trendHeatmap() },
        { name: "trendHeatmap (active days)", factory: () => trendHeatmap({ metric: "activeDays" }) },
        { name: "trendHeatmap (hours)", factory: () => trendHeatmap({ metric: "expertHours" }) },
        { name: "trendHeatmap (sessions)", factory: () => trendHeatmap({ metric: "sessions" }) },
    ];

    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));
        const derived = collectDerivedFields(vegaLiteSpec);

        for (const field of collectFields(vegaLiteSpec)) {
            if (derived.has(field)) continue;
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it("leaves no unsubstituted placeholders in the org spec", () => {
        const serialized = JSON.stringify(activationByOrg().vegaLiteSpec);
        expect(serialized).not.toMatch(/__[A-Z]+__/);
    });

    it("leaves no unsubstituted placeholders in the heatmap spec", () => {
        const serialized = JSON.stringify(trendHeatmap({ metric: "sessions" }).vegaLiteSpec);
        expect(serialized).not.toMatch(/__[A-Z]+__/);
    });

    // DAX returns dates as ISO strings. Vega-Lite's `timeUnit` does not parse
    // them, so every point collapses onto one x position and the marks render
    // with empty geometry - a failure no type check or unit test can see.
    // Dates must be converted with an explicit `toDate` calculate transform.
    it.each(specModules)("$name never relies on timeUnit to parse dates", ({ factory }) => {
        const serialized = JSON.stringify(factory().vegaLiteSpec);
        expect(serialized).not.toMatch(/"timeUnit"/);
    });

    it("derives the habit trend month with an explicit date conversion", () => {
        const spec = habitTrend().vegaLiteSpec as {
            transform: { calculate?: string; as?: string }[];
            encoding: { x: { field: string; type: string } };
        };
        const monthField = spec.encoding.x.field;

        expect(spec.encoding.x.type).toBe("temporal");
        expect(
            spec.transform.some(
                (step) => step.as === monthField && step.calculate?.includes("toDate("),
            ),
            `x field "${monthField}" must come from a toDate transform`,
        ).toBe(true);
    });

    it("drops the colour legend when a single series is plotted", () => {
        const single = adoptionTrend({ measure: "sessions" }).vegaLiteSpec as { encoding: { color?: unknown } };
        expect(single.encoding.color).toBeUndefined();

        const multi = adoptionTrend().vegaLiteSpec as { encoding: { color?: unknown } };
        expect(multi.encoding.color).toBeDefined();
    });

    it("does not let one variant's spec changes leak into the next", () => {
        adoptionTrend({ measure: "hours" });
        const followUp = adoptionTrend().vegaLiteSpec as {
            transform: { fold?: string[] }[];
            encoding: { color?: unknown };
        };
        expect(followUp.transform.find((step) => step.fold)?.fold).toEqual(["Licensed", "Unlicensed", "Agents"]);
        expect(followUp.encoding.color).toBeDefined();
    });

    it("does not let one heatmap metric's spec changes leak into the next", () => {
        trendHeatmap({ metric: "sessions" });
        const followUp = trendHeatmap().vegaLiteSpec as unknown as {
            layer: [{ encoding: { color: { field: string } } }];
        };

        expect(followUp.layer[0].encoding.color.field).toBe("Active Users");
    });
});
