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
    concentrationIncomplete,
    concentrationHeadline,
    EQUAL_SHARE,
    MAX_POINTS,
    PEOPLE_SHARE,
    paretoSpec,
    paretoTable,
    personValues,
    readConcentration,
    readConcentrationSlices,
    sliceLabel,
    TOP_SLICES,
    TOTAL_SHARE,
    type Concentration,
    type ConcentrationSlices,
} from "./concentration";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "./headline";
import leaderboardQuery from "@/queries/work/leaderboard-concentration.dax?raw";
import studioQuery from "@/queries/consumption/studio-concentration.dax?raw";
import habitQuery from "@/queries/value/value-by-habit.dax?raw";

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

const CUT_COLUMNS = ["Count", "Cumulative", "People", "Total"];

function cutTable(rows: unknown[][]): DataTable {
    return { columns: CUT_COLUMNS.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

/**
 * The cut rows the concentration queries return, worked out as their DAX
 * does: the counts each slice and, unless `curve` is false as on
 * Leaderboards, each curve point could round to, and for each the sum of
 * TOPN's rows, which keeps every tie at the cut, less the ties past it. Sum
 * strict winners plus the required boundary ties to avoid cancellation when
 * a large tied population shares a small decimal value.
 */
function daxCuts(input: readonly number[], curve = true): unknown[][] {
    const values = input.filter((value) => value > 0);
    const people = values.length;
    const total = values.reduce((sum, value) => sum + value, 0);
    const steps = Math.min(people, 100);
    const quotient = (a: number, b: number) => Math.trunc(a / b);
    const counts = new Set<number>();
    for (const pct of [1, 5, 25]) counts.add(quotient(people * pct + 99, 100));
    for (let step = 1; curve && step <= steps; step++) {
        counts.add(quotient(step * people, steps));
        counts.add(quotient(step * people + steps - 1, steps));
    }
    const sorted = [...values].sort((a, b) => b - a);
    return [...counts]
        .filter((count) => count >= 1)
        .map((count) => {
            const top = values.filter((value) => value >= sorted[count - 1]);
            const boundary = Math.min(...top);
            const higher = top.filter((value) => value > boundary);
            return [count, higher.reduce((sum, value) => sum + value, 0) + (count - higher.length) * boundary, people, total];
        });
}

/** A repeatable stream of numbers from 0 to 1. */
function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

describe("concentration from the model", () => {
    it("matches the figures from every person's value, ties and all", () => {
        const next = random(7);
        const sizes = [1, 2, 3, 4, 5, 19, 20, 21, 99, 100, 101, 140, 150, 199, 200, 201, 333, 700, 1001, 5000];
        for (let size = 1; size <= 3000; size += 37) sizes.push(size);
        for (const size of sizes) {
            const spread = 1 + Math.floor(next() * 40);
            const values = Array.from({ length: size }, () => Math.floor(next() * spread) - 1);
            const rows = daxCuts(values);
            expect(rows.length).toBeLessThanOrEqual(203);
            expect(readConcentration(cutTable(rows)), `${size} people`).toEqual(concentration(values));
        }
    });

    it("matches to rounding for fractional values", () => {
        const next = random(11);
        const values = Array.from({ length: 2345 }, () => Math.round(next() * next() * 1000) / 8);
        const read = readConcentration(cutTable(daxCuts(values)));
        const direct = concentration(values);
        expect(read?.people).toBe(direct?.people);
        expect(read?.slices.map((slice) => slice.people)).toEqual(direct?.slices.map((slice) => slice.people));
        read?.slices.forEach((slice, index) => expect(slice.share).toBeCloseTo(direct?.slices[index].share ?? 0, 9));
        expect(read?.points.length).toBe(direct?.points.length);
        read?.points.forEach((point, index) => {
            expect(point.peopleShare).toBe(direct?.points[index].peopleShare);
            expect(point.totalShare).toBeCloseTo(direct?.points[index].totalShare ?? 0, 9);
        });
    });

    it("keeps decimal cutoff ties within a relative tolerance of 1e-9", () => {
        const values = Array.from({ length: 10001 }, () => 0.00037);
        const read = readConcentration(cutTable(daxCuts(values)))!;
        const direct = concentration(values)!;
        expect(read.people).toBe(10001);
        read.points.forEach((point, index) => {
            const expected = direct.points[index].totalShare;
            expect(Math.abs(point.totalShare - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-9);
        });
    });

    it("says nothing without people, or when a cut is missing", () => {
        expect(readConcentration(undefined)).toBeUndefined();
        expect(readConcentration(cutTable([]))).toBeUndefined();
        const rows = daxCuts([5, 4, 3, 2, 1]);
        expect(readConcentration(cutTable(rows.filter((row) => row[0] !== 5)))).toBeUndefined();
        expect(readConcentration({ columns: [], rows } as unknown as DataTable)).toBeUndefined();
    });

    it("does not round an exact five-percent cut up because of binary floating point", () => {
        const values = Array.from({ length: 140 }, () => 1);
        expect(concentration(values)?.slices.find((slice) => slice.pct === 0.05)?.people).toBe(7);
        expect(readConcentration(cutTable(daxCuts(values)))).toEqual(concentration(values));
    });

    it.each([
        [1, NaN, 2, 3],
        [1, Infinity, 2, 3],
        [1.5, 2, 2, 3],
        [1, 4, 2, 3],
        [1, 2, 2.5, 3],
        [1, 2, 2, Infinity],
        [1, 2, 3, 3],
    ])("rejects malformed cuts instead of drawing plausible partial figures (%s)", (...row) => {
        const table = cutTable([row, [2, 3, 2, 3]]);
        expect(readConcentration(table)).toBeUndefined();
        expect(readConcentrationSlices(table)).toBeUndefined();
        expect(concentrationIncomplete(table, undefined)).toBe(true);
    });

    it("distinguishes no activity from missing data, and permits zero-hour habit rows", () => {
        expect(concentrationIncomplete(cutTable([]), undefined)).toBe(false);
        expect(concentrationIncomplete(cutTable([[1, 2, 2, 3]]), undefined)).toBe(true);
        const table = {
            columns: [...CUT_COLUMNS, "Cohort", "Hours"].map((name) => ({ name })),
            rows: [[null, null, 5, null, "Beginner", 0]],
        };
        expect(concentrationIncomplete(table, undefined)).toBe(false);
        expect(concentrationIncomplete({ ...table, rows: [[null, null, 5, null, "Beginner", 1]] }, undefined)).toBe(true);
    });

    it("skips rows without a count beside the cuts", () => {
        const rows = [[null, null, 9, null], ...daxCuts([3, 1, 2])];
        expect(readConcentration(cutTable(rows))).toEqual(concentration([3, 1, 2]));
        expect(readConcentrationSlices(cutTable(rows))).toEqual(slicesOf(concentration([3, 1, 2])));
    });

    it("works the cuts out the same way in every query", () => {
        const tail = (query: string) => {
            const text = query.replace(/\r\n/g, "\n").replace(/^(\/\/|--)/gm, "");
            return text.slice(text.indexOf(" The cuts lib/concentration.ts reads"), text.lastIndexOf("RETURN"));
        };
        expect(tail(studioQuery)).toMatch(/^ The cuts[\s\S]*TOPN\(\[@Count\], __Values, \[@Value\], DESC\)/);
        expect(tail(habitQuery)).toBe(tail(studioQuery));
    });

    // Leaderboards shows the top slices without a curve, so its query keeps
    // only their cuts, each summed by the same lines as the curve queries'.
    it("works out Leaderboards' top slices as the curve queries do, without the curve", () => {
        const code = (query: string) => {
            const lines = query.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
            const body = lines.filter((line) => !/^(\/\/|--)/.test(line));
            return body.slice(body.indexOf("VAR __Total = SUMX(__Values, [@Value])")).join("\n").trim();
        };
        const withoutCurve = code(studioQuery)
            .replace("VAR __Steps = MAX(1, MIN(__Count, 100))\n", "")
            .replace(/UNION\(\n(SELECTCOLUMNS\(\{ 1, 5, 25 \}.*\)),\n(?:SELECTCOLUMNS\(GENERATESERIES.*\n){2}\)\n/, "$1\n");
        expect(withoutCurve).toContain("VAR __Total = SUMX(__Values, [@Value])");
        expect(withoutCurve).not.toMatch(/GENERATESERIES|UNION|__Steps/);
        expect(code(leaderboardQuery)).toBe(withoutCurve);
        const listed = /SELECTCOLUMNS\(\{ ([\d, ]+) \}, "@Count"/.exec(leaderboardQuery)?.[1].split(", ").map(Number);
        expect(listed).toEqual(TOP_SLICES.map((pct) => Math.round(pct * 100)));
    });
});

/** The figures the curve's reader gives, less the curve. */
function slicesOf(result: Concentration | undefined): ConcentrationSlices | undefined {
    return result && { total: result.total, people: result.people, slices: result.slices };
}

describe("top slices from the model", () => {
    it("matches the curve's slices for the same people, ties and all", () => {
        const next = random(13);
        const sizes = [1, 2, 3, 4, 5, 19, 20, 21, 99, 100, 101, 140, 150, 199, 200, 201, 333, 700, 1001, 5000, 20000];
        for (let size = 1; size <= 3000; size += 37) sizes.push(size);
        for (const size of sizes) {
            const spread = 1 + Math.floor(next() * 40);
            const values = Array.from({ length: size }, () => Math.floor(next() * spread) - 1);
            const rows = daxCuts(values, false);
            expect(rows.length).toBeLessThanOrEqual(TOP_SLICES.length);
            const curve = readConcentration(cutTable(daxCuts(values)));
            const read = readConcentrationSlices(cutTable(rows));
            expect(read, `${size} people`).toEqual(slicesOf(curve));
            expect(read, `${size} people`).toEqual(slicesOf(concentration(values)));
            expect(readConcentrationSlices(cutTable(daxCuts(values))), `${size} people`).toEqual(read);
            expect(concentrationHeadline(read, "sessions")).toBe(concentrationHeadline(curve, "sessions"));
        }
    });

    it("counts people tied at a cut only up to the cut, as the curve's slices do", () => {
        // 100 people: 3 on 10 sessions, 10 tied on 5 and 87 on 1. The top 5% is
        // the 3 and two of the 10 tied, 30 + 2 × 5 = 40 of the 167 sessions.
        const values = [...Array<number>(3).fill(10), ...Array<number>(10).fill(5), ...Array<number>(87).fill(1)];
        const read = readConcentrationSlices(cutTable(daxCuts(values, false)));
        expect(read).toEqual({
            total: 167,
            people: 100,
            slices: [
                { pct: 0.05, people: 5, share: 40 / 167 },
                { pct: 0.25, people: 25, share: 92 / 167 },
            ],
        });
        expect(read).toEqual(slicesOf(readConcentration(cutTable(daxCuts(values)))));
    });

    it("finds every slice among the three cuts, for any number of people", () => {
        const unread: number[] = [];
        for (let people = 1; people <= 50000; people++) {
            const counts = new Set([1, 5, 25].map((pct) => Math.trunc((people * pct + 99) / 100)));
            const rows = [...counts].map((count) => [count, count, people, people]);
            if (readConcentrationSlices(cutTable(rows))?.people !== people) unread.push(people);
        }
        expect(unread).toEqual([]);
    });

    it("does not round an exact five-percent cut up because of binary floating point", () => {
        const values = Array.from({ length: 140 }, () => 1);
        const rows = daxCuts(values, false);
        expect(rows.map((row) => row[0])).toEqual([2, 7, 35]);
        expect(readConcentrationSlices(cutTable(rows))?.slices.find((slice) => slice.pct === 0.05)?.people).toBe(7);
    });

    it("reads a handful of people, whose slices share one cut", () => {
        for (const values of [[7], [7, 3], [2, 2, 2], [4, 3, 2, 1]]) {
            const rows = daxCuts(values, false);
            expect(rows.map((row) => row[0])).toEqual([1]);
            expect(readConcentrationSlices(cutTable(rows))).toEqual({
                total: values.reduce((sum, value) => sum + value, 0),
                people: values.length,
                slices: [],
            });
        }
    });

    it("matches to rounding for fractional values", () => {
        const next = random(11);
        const values = Array.from({ length: 2345 }, () => Math.round(next() * next() * 1000) / 8);
        const read = readConcentrationSlices(cutTable(daxCuts(values, false)));
        const direct = concentration(values);
        expect(read).toEqual(slicesOf(readConcentration(cutTable(daxCuts(values)))));
        expect(read?.people).toBe(direct?.people);
        expect(read?.slices.map((slice) => slice.people)).toEqual(direct?.slices.map((slice) => slice.people));
        read?.slices.forEach((slice, index) => expect(slice.share).toBeCloseTo(direct?.slices[index].share ?? 0, 9));
    });

    it("keeps decimal cutoff ties within a relative tolerance of 1e-9", () => {
        const values = Array.from({ length: 10001 }, () => 0.00037);
        const read = readConcentrationSlices(cutTable(daxCuts(values, false)))!;
        const direct = concentration(values)!;
        expect(read).toEqual(slicesOf(readConcentration(cutTable(daxCuts(values)))));
        expect(read.slices.map((slice) => slice.people)).toEqual([101, 501, 2501]);
        read.slices.forEach((slice, index) => {
            const expected = direct.slices[index].share;
            expect(Math.abs(slice.share - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-9);
        });
    });

    it("says nothing without people, or when a slice's cut is missing", () => {
        expect(readConcentrationSlices(undefined)).toBeUndefined();
        expect(readConcentrationSlices(cutTable([]))).toBeUndefined();
        expect(concentrationIncomplete(cutTable([]), undefined)).toBe(false);
        const rows = daxCuts(Array.from({ length: 100 }, (_, index) => 100 - index), false);
        expect(rows.map((row) => row[0])).toEqual([1, 5, 25]);
        for (const count of [1, 5, 25]) {
            const table = cutTable(rows.filter((row) => row[0] !== count));
            expect(readConcentrationSlices(table), `without ${count}`).toBeUndefined();
            expect(concentrationIncomplete(table, undefined)).toBe(true);
        }
        expect(readConcentrationSlices({ columns: [], rows } as unknown as DataTable)).toBeUndefined();
    });

    it("rejects a cut of everyone that misses the total", () => {
        expect(readConcentrationSlices(cutTable([[1, 6, 1, 6]]))).toEqual({ total: 6, people: 1, slices: [] });
        expect(readConcentrationSlices(cutTable([[1, 5, 1, 6]]))).toBeUndefined();
    });

    it("doesn't give the curve's reader the cuts it needs", () => {
        const rows = daxCuts(Array.from({ length: 100 }, (_, index) => 100 - index), false);
        expect(readConcentration(cutTable(rows))).toBeUndefined();
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

    it("treats blank and empty person keys as one person, like the aggregate queries", () => {
        const blankRows = {
            columns: [{ name: "User" }, { name: "Sessions" }],
            rows: [[null, 3], ["", 2], ["named", 4]],
        } as unknown as DataTable;
        expect(personValues(blankRows, "User", "Sessions")).toEqual([5, 4]);
        expect(leaderboardQuery).toContain(`"@Person", COALESCE('Chat + Agent Interactions (Audit Logs)'[Audit_UserId], "")`);
        expect(studioQuery).toContain(`"@Person", COALESCE('Credit Consumption (User)'[User Name], "")`);
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
