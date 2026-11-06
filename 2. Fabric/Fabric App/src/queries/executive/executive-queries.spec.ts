//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    BROAD_USER_SKILLS,
    EXCLUDED_KINDS,
    executiveCreditDates,
    executiveCredits,
    executiveDepartments,
    executiveMonths,
    executiveSummary,
    executiveWorkKinds,
    FADED_OPACITY,
    monthLabel,
    shapeMonthlyTrend,
    WORK_KINDS_SHOWN,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import creditDateRows from "./__fixtures__/executive-credit-dates.rows.json";
import creditRows from "./__fixtures__/executive-credits.rows.json";
import departmentRows from "./__fixtures__/executive-departments.rows.json";
import monthRows from "./__fixtures__/executive-months.rows.json";
import summaryRows from "./__fixtures__/executive-summary.rows.json";
import workKindRows from "./__fixtures__/executive-work-kinds.rows.json";
import hoursSpec from "./executive-hours.json";

const modules = [
    { name: "executiveSummary", factory: executiveSummary, columns: liveColumns.executiveSummary, rows: summaryRows, connection: "vl" },
    { name: "executiveMonths", factory: () => executiveMonths(), columns: liveColumns.executiveMonths, rows: monthRows, connection: "vl" },
    { name: "executiveDepartments", factory: executiveDepartments, columns: liveColumns.executiveDepartments, rows: departmentRows, connection: "vl" },
    { name: "executiveWorkKinds", factory: executiveWorkKinds, columns: liveColumns.executiveWorkKinds, rows: workKindRows, connection: "vl" },
    { name: "executiveCredits", factory: () => executiveCredits(), columns: liveColumns.executiveCredits, rows: creditRows, connection: "cc" },
    { name: "executiveCreditDates", factory: executiveCreditDates, columns: liveColumns.executiveCreditDates, rows: creditDateRows, connection: "cc" },
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
                if (Array.isArray(value)) value.forEach((item) => typeof item === "string" && found.add(item));
            } else {
                collectDerivedFields(value, found);
            }
        }
    }
    return found;
}

describe("executive query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name's captured rows carry exactly those columns", ({ rows, columns }) => {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(Object.keys(row).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets its model", ({ factory, connection }) => {
        expect(factory().connection).toBe(connection);
    });

    it.each(modules)("$name ships a non-empty DAX query", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
        expect(raw).toContain("EVALUATE");
    });
});

describe("executive spec field references", () => {
    const specModules = [
        { name: "executiveMonths", factory: () => executiveMonths() },
        { name: "executiveMonths (shaped)", factory: () => executiveMonths({ months: ["May 2026"], rangeMonth: "2026-05-01" }) },
        { name: "executiveCredits", factory: () => executiveCredits() },
        { name: "executiveWorkKinds", factory: () => executiveWorkKinds() },
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

    it.each(specModules)("$name has no timeUnit and no placeholders", ({ factory }) => {
        const serialized = JSON.stringify(factory().vegaLiteSpec);
        expect(serialized).not.toContain("timeUnit");
        expect(serialized).not.toMatch(/__[A-Z]+__/);
    });

    it("never prints money", () => {
        for (const { factory } of specModules) {
            const spec = { ...(factory().vegaLiteSpec as Record<string, unknown>) };
            delete spec.$schema;
            expect(JSON.stringify(spec)).not.toMatch(/[$£€¥]|Cost|Spend|Price/i);
        }
    });
});

describe("the excluded kinds of work", () => {
    const queries = [executiveSummary(), executiveMonths(), executiveDepartments(), executiveWorkKinds()];

    it("are left out by every query that counts skills or ranks work", () => {
        for (const { query } of queries) {
            for (const kind of EXCLUDED_KINDS) expect(query).toContain(`"${kind}"`);
        }
    });

    it("never appear among the ranked kinds of work", () => {
        const kinds = workKindRows.map((row) => row["Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]"]);
        for (const kind of EXCLUDED_KINDS) expect(kinds).not.toContain(kind);
    });

    it("rank as many kinds of work as the chart promises", () => {
        expect(executiveWorkKinds().query).toContain(`TOPN(${WORK_KINDS_SHOWN},`);
        expect(workKindRows.length).toBeLessThanOrEqual(WORK_KINDS_SHOWN);
    });

    it("count a broad user at the documented threshold", () => {
        expect(executiveSummary().query).toContain(`[ValueLens Skills In Use] >= ${BROAD_USER_SKILLS}`);
    });
});

describe("shapeMonthlyTrend", () => {
    const transformOf = (spec: unknown) =>
        (spec as { transform: { calculate?: string; as?: string }[] }).transform.find((step) => step.as === "Emphasis");
    const xDomain = (spec: unknown) => (spec as { encoding: { x: { scale: { domain?: string[] } } } }).encoding.x.scale.domain;
    const colorRange = (spec: unknown) =>
        (spec as { layer: { encoding: { color: { scale: { range: string[] } } } }[] }).layer[0].encoding.color.scale.range;

    it("labels months the way the spec prints them", () => {
        expect(monthLabel("2026-05-01")).toBe("May 2026");
        expect(monthLabel("2025-12-01T00:00:00")).toBe("Dec 2025");
    });

    it("fixes the x axis to the months given", () => {
        const months = ["Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026"];
        expect(xDomain(shapeMonthlyTrend(hoursSpec, { months }))).toEqual(months);
        expect(xDomain(shapeMonthlyTrend(hoursSpec))).toBeUndefined();
    });

    it("fades the months before the date range", () => {
        const emphasis = transformOf(shapeMonthlyTrend(hoursSpec, { rangeMonth: "2026-05-01" }));
        expect(emphasis?.calculate).toBe(`datum['Month Start'] < '2026-05-01' ? ${FADED_OPACITY} : 1`);
    });

    it("ignores a range month that is not an ISO date", () => {
        const emphasis = transformOf(shapeMonthlyTrend(hoursSpec, { rangeMonth: "May' ? 0 : 1 //" }));
        expect(emphasis?.calculate).toBe("1");
    });

    it("applies theme colours only when there is one per series", () => {
        const colors = ["#111111", "#222222", "#333333"];
        expect(colorRange(shapeMonthlyTrend(hoursSpec, { colors }))).toEqual(colors);
        expect(colorRange(shapeMonthlyTrend(hoursSpec, { colors: ["#111111"] }))).toEqual(colorRange(hoursSpec));
    });

    it("never mutates the shipped spec", () => {
        const before = JSON.stringify(hoursSpec);
        shapeMonthlyTrend(hoursSpec, { months: ["May 2026"], rangeMonth: "2026-05-01", colors: ["#1", "#2", "#3"] });
        expect(JSON.stringify(hoursSpec)).toBe(before);
    });
});
