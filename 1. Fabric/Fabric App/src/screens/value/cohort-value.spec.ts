//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { compile, type TopLevelSpec } from "vega-lite";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import {
    cohortValueHeadline,
    hiddenHabits,
    ladderSpec,
    ladderTable,
    readValueByHabit,
    type LadderHabit,
} from "./cohort-value";

const COLUMNS = ["Month", "User", "Active Days", "Cohort", "Hours"];

function table(rows: unknown[][]): DataTable {
    return { columns: COLUMNS.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

/** `count` people in a habit, each with `hours`. */
function people(habit: LadderHabit, count: number, hours: number): unknown[][] {
    return Array.from({ length: count }, (_, index) => ["2025-03-01T00:00:00", `${habit}-${index}`, 1, habit, hours]);
}

describe("value by habit", () => {
    it("totals each habit, Beginner first, and keeps every person's hours", () => {
        const read = readValueByHabit(
            table([...people("Power", 5, 6), ...people("Beginner", 10, 1), ["2025-03-01T00:00:00", "x", 7, "Developing", null]]),
        );
        expect(read.month).toBe("2025-03-01");
        expect(read.cohorts.map((cohort) => cohort.habit)).toEqual(["Beginner", "Developing", "Habitual", "Power"]);
        expect(read.cohorts[0]).toEqual({ habit: "Beginner", people: 10, hours: 10, perPerson: 1 });
        expect(read.cohorts[3]).toEqual({ habit: "Power", people: 5, hours: 30, perPerson: 6 });
        expect(read.cohorts[2]).toEqual({ habit: "Habitual", people: 0, hours: 0, perPerson: undefined });
        expect(read.hoursByPerson).toHaveLength(16);
    });

    it("leaves hours per person out for a habit of fewer than five people", () => {
        const read = readValueByHabit(table([...people("Developing", 4, 3), ...people("Beginner", 5, 1)]));
        expect(read.cohorts[1]).toMatchObject({ habit: "Developing", people: 4, perPerson: undefined });
        expect(hiddenHabits(read)).toEqual(["Developing"]);
        expect(ladderTable(read).rows.map((row) => row[0])).toEqual(["Beginner"]);
    });

    it("ignores habits it doesn't know", () => {
        expect(readValueByHabit(table([["2025-03-01", "x", 0, "Inactive", 9]])).hoursByPerson).toEqual([]);
    });
});

describe("value by habit headline", () => {
    it("compares Power users with Beginners", () => {
        const read = readValueByHabit(
            table([...people("Power", 5, 6.2), ...people("Habitual", 6, 3), ...people("Beginner", 8, 0.8)]),
        );
        expect(cohortValueHeadline(read)).toBe(
            "Power users logged 6.2 expert hours each in March 2025, against 0.8 for Beginners.",
        );
    });

    it("falls back to the heaviest and lightest habits with enough people", () => {
        const read = readValueByHabit(
            table([...people("Power", 3, 9), ...people("Habitual", 6, 3), ...people("Developing", 5, 1.5), ...people("Beginner", 2, 1)]),
        );
        expect(cohortValueHeadline(read)).toBe(
            "Habitual users logged 3.0 expert hours each in March 2025, against 1.5 for Developing users.",
        );
    });

    it("says nothing with fewer than two habits to compare", () => {
        expect(cohortValueHeadline(readValueByHabit(table(people("Power", 20, 4))))).toBeUndefined();
        expect(cohortValueHeadline(readValueByHabit(table([])))).toBeUndefined();
    });

    it("never claims a cause", () => {
        const read = readValueByHabit(table([...people("Power", 5, 6), ...people("Beginner", 5, 1)]));
        expect(cohortValueHeadline(read)).not.toMatch(CAUSAL_WORDS);
    });
});

describe("value by habit ladder", () => {
    it("only reads columns the table provides and compiles", () => {
        const read = readValueByHabit(table([...people("Power", 5, 6), ...people("Beginner", 5, 1)]));
        const ladder = ladderTable(read);
        const names = ladder.columns.map((column) => column.name);
        const text = JSON.stringify(ladderSpec());
        for (const [, field] of text.matchAll(/"field":"([^"]+)"/g)) expect(names).toContain(field);
        expect(text).not.toContain('"timeUnit"');

        const values = ladder.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
        const spec = { ...(ladderSpec() as object), width: 400, height: 200, data: { values } };
        expect(() => compile(spec as TopLevelSpec)).not.toThrow();
    });
});
