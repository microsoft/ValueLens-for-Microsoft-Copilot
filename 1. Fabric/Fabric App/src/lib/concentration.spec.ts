//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import {
    concentration,
    concentrationHeadline,
    EQUAL_SHARE,
    MAX_POINTS,
    PEOPLE_SHARE,
    paretoSpec,
    paretoTable,
    personValues,
    sliceLabel,
    TOTAL_SHARE,
} from "./concentration";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "./headline";

/** Every `field` reference anywhere in a Vega-Lite spec. */
function collectFields(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach((item) => collectFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "field" && typeof value === "string") found.add(value);
            else collectFields(value, found);
        }
    }
    return found;
}

describe("concentration", () => {
    it("says nothing without a positive total", () => {
        expect(concentration([])).toBeUndefined();
        expect(concentration([0, 0, -3, Number.NaN])).toBeUndefined();
    });

    it("counts only people with a value", () => {
        const result = concentration([5, 0, 3, 0, 2]);
        expect(result).toMatchObject({ total: 10, people: 3 });
    });

    it("reports only slices that hold at least five people", () => {
        // 100 people: top 1% is 1 person, top 5% is 5, top 25% is 25.
        const values = Array.from({ length: 100 }, (_, index) => 100 - index);
        const result = concentration(values)!;
        expect(result.slices.map((slice) => slice.pct)).toEqual([0.05, 0.25]);
        const total = values.reduce((sum, value) => sum + value, 0);
        expect(result.slices[0]).toEqual({ pct: 0.05, people: 5, share: (100 + 99 + 98 + 97 + 96) / total });
        expect(result.slices[1].people).toBe(25);
    });

    it("rounds slice sizes up", () => {
        // 17 people: 25% is 4.25, so 5 people.
        const result = concentration(Array.from({ length: 17 }, () => 1))!;
        expect(result.slices).toEqual([{ pct: 0.25, people: 5, share: 5 / 17 }]);
    });

    it("reports every slice for a large population", () => {
        const result = concentration(Array.from({ length: 1000 }, (_, index) => index + 1))!;
        expect(result.slices.map((slice) => [slice.pct, slice.people])).toEqual([
            [0.01, 10],
            [0.05, 50],
            [0.25, 250],
        ]);
    });

    it("omits every slice for a handful of people", () => {
        expect(concentration([4, 3, 2, 1])!.slices).toEqual([]);
    });

    it("draws the curve from the origin to the full total, busiest first", () => {
        const result = concentration([1, 3, 6])!;
        expect(result.points).toEqual([
            { peopleShare: 0, totalShare: 0 },
            { peopleShare: 1 / 3, totalShare: 0.6 },
            { peopleShare: 2 / 3, totalShare: 0.9 },
            { peopleShare: 1, totalShare: 1 },
        ]);
    });

    it("thins a long curve but keeps both ends and stays rising", () => {
        const result = concentration(Array.from({ length: 5000 }, (_, index) => (index % 37) + 1))!;
        expect(result.points.length).toBeLessThanOrEqual(MAX_POINTS);
        expect(result.points[0]).toEqual({ peopleShare: 0, totalShare: 0 });
        expect(result.points.at(-1)!.peopleShare).toBe(1);
        expect(result.points.at(-1)!.totalShare).toBeCloseTo(1, 10);
        for (let index = 1; index < result.points.length; index++) {
            expect(result.points[index].peopleShare).toBeGreaterThan(result.points[index - 1].peopleShare);
            expect(result.points[index].totalShare).toBeGreaterThanOrEqual(result.points[index - 1].totalShare);
        }
    });
});

describe("person values", () => {
    const table = {
        columns: ["Group", "User", "Is Grand Total", "Is Group Total", "Sessions"].map((name) => ({ name, displayName: name })),
        rows: [
            [null, null, true, true, 30],
            ["A", null, false, true, 20],
            ["A", "ana", false, false, 12],
            ["A", "ben", false, false, 8],
            ["B", "ana", false, false, 4],
            ["B", "cy", false, false, null],
        ],
    } as unknown as DataTable;

    it("sums each person's rows and skips totals", () => {
        expect(personValues(table, "User", "Sessions", ["Is Grand Total", "Is Group Total"])).toEqual([16, 8]);
    });

    it("waits for a table and tolerates missing columns", () => {
        expect(personValues(undefined, "User", "Sessions")).toBeUndefined();
        expect(personValues(table, "Person", "Sessions")).toEqual([]);
    });
});

describe("concentration headline", () => {
    it("leads with the top 5%", () => {
        const values = Array.from({ length: 100 }, (_, index) => (index < 5 ? 76 : 2));
        // 5 × 76 = 380 of 380 + 95 × 2 = 570.
        expect(concentrationHeadline(concentration(values), "sessions")).toBe(
            "The top 5% of people account for 67% of sessions.",
        );
    });

    it("falls back to the top 25% when 5% is too few people", () => {
        const values = Array.from({ length: 20 }, (_, index) => (index < 5 ? 10 : 1));
        expect(concentrationHeadline(concentration(values), "credits")).toBe(
            "The top 25% of people account for 77% of credits.",
        );
    });

    it("says nothing when no slice can be reported", () => {
        expect(concentrationHeadline(concentration([9, 1]), "sessions")).toBeUndefined();
        expect(concentrationHeadline(undefined, "sessions")).toBeUndefined();
    });

    it("never claims a cause", () => {
        for (const size of [20, 100, 1000]) {
            const sentence = concentrationHeadline(
                concentration(Array.from({ length: size }, (_, index) => index + 1)),
                "expert hours",
            );
            expect(sentence).toBeDefined();
            expect(sentence).not.toMatch(CAUSAL_WORDS);
        }
    });

    it("labels slices as whole percentages", () => {
        expect([0.01, 0.05, 0.25].map(sliceLabel)).toEqual(["1%", "5%", "25%"]);
    });
});

describe("pareto chart", () => {
    it("tables the curve with the equal-share diagonal", () => {
        const table = paretoTable(concentration([1, 3, 6]));
        expect(table.columns.map((column) => column.name)).toEqual([PEOPLE_SHARE, TOTAL_SHARE, EQUAL_SHARE]);
        expect(table.rows[1]).toEqual([1 / 3, 0.6, 1 / 3]);
        expect(paretoTable(undefined).rows).toEqual([]);
    });

    it("only reads columns the table provides", () => {
        const spec = paretoSpec("sessions");
        const provided = new Set([PEOPLE_SHARE, TOTAL_SHARE, EQUAL_SHARE, "Series", "Share"]);
        for (const field of collectFields(spec)) expect(provided).toContain(field);
        const text = JSON.stringify(spec);
        expect(text).not.toMatch(/__\w+__/);
        expect(text).not.toContain('"timeUnit"');
        expect(text).toContain("Share of sessions");
    });

    it("compiles as Vega-Lite", () => {
        const table = paretoTable(concentration([1, 3, 6]));
        const values = table.rows.map((row) =>
            Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]])),
        );
        const spec = { ...(paretoSpec("sessions") as object), width: 400, height: 300, data: { values } };
        expect(() => compile(spec as TopLevelSpec)).not.toThrow();
    });
});
