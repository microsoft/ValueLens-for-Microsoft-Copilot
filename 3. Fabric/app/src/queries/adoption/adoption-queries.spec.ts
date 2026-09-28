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
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "activationSummary", factory: activationSummary, columns: liveColumns.activationSummary },
    { name: "activationByOrg", factory: activationByOrg, columns: liveColumns.activationByOrg },
    { name: "adoptionSummary", factory: adoptionSummary, columns: liveColumns.adoptionSummary },
    { name: "adoptionTrend", factory: adoptionTrend, columns: liveColumns.adoptionTrend },
    { name: "habitSummary", factory: habitSummary, columns: liveColumns.habitSummary },
    { name: "habitTrend", factory: habitTrend, columns: liveColumns.habitTrend },
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
        expect(factory().query.trim()).toMatch(/^EVALUATE/);
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

    it("drops the colour legend when a single series is plotted", () => {
        const single = adoptionTrend({ measure: "sessions" }).vegaLiteSpec as { encoding: { color?: unknown } };
        expect(single.encoding.color).toBeUndefined();

        const multi = adoptionTrend().vegaLiteSpec as { encoding: { color?: unknown } };
        expect(multi.encoding.color).toBeDefined();
    });

    it("does not let one variant's spec changes leak into the next", () => {
        adoptionTrend({ measure: "hours" });
        const followUp = adoptionTrend().vegaLiteSpec as {
            transform: { fold: string[] }[];
            encoding: { color?: unknown };
        };
        expect(followUp.transform[0].fold).toEqual(["Licensed", "Unlicensed", "Agents"]);
        expect(followUp.encoding.color).toBeDefined();
    });
});
