//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { habitLicenceHeadline, monthLabel, readHabitLicence, type HabitLicenceMatrix } from "./habit-licence";

const COLUMNS = ["Month", "Cohort", "Cohort Order", "Licensed", "Unlicensed"];

function table(rows: unknown[][]): DataTable {
    return { columns: COLUMNS.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

function matrix(counts: Record<string, [number, number]>): HabitLicenceMatrix {
    const order = ["Power", "Habitual", "Developing", "Beginner"];
    return readHabitLicence(
        table(
            order.map((habit, index) => [
                "2025-03-01T00:00:00",
                habit,
                index + 1,
                counts[habit]?.[0] ?? 0,
                counts[habit]?.[1] ?? 0,
            ]),
        ),
    );
}

describe("habit by licence", () => {
    it("reads the four habits in order and totals them", () => {
        const read = readHabitLicence(
            table([
                ["2025-03-01T00:00:00", "Beginner", 4, 40, 12],
                ["2025-03-01T00:00:00", "Power", 1, 20, 3],
                ["2025-03-01T00:00:00", "Habitual", 2, 15, null],
            ]),
        );
        expect(read.month).toBe("2025-03-01");
        expect(read.rows.map((row) => row.habit)).toEqual(["Power", "Habitual", "Developing", "Beginner"]);
        expect(read.rows[2]).toEqual({ habit: "Developing", licensed: 0, unlicensed: 0 });
        expect(read).toMatchObject({ licensed: 75, unlicensed: 15, heavyLicensed: 35, heavyUnlicensed: 3 });
    });

    it("ignores habits it doesn't know", () => {
        const read = readHabitLicence(table([["2025-03-01T00:00:00", "Inactive", 5, 9, 9]]));
        expect(read.licensed + read.unlicensed).toBe(0);
    });

    it("names the month in full", () => {
        expect(monthLabel("2025-03-01")).toBe("March 2025");
        expect(monthLabel(undefined)).toBe("the last full month");
    });

    it("says how many heavy users had no licence, with their share", () => {
        expect(habitLicenceHeadline(matrix({ Power: [10, 4], Habitual: [20, 6], Beginner: [30, 30] }))).toBe(
            "10 people without a licence were active on 11 or more days in March 2025, 25% of everyone that active.",
        );
    });

    it("drops the share when the heavy group is small", () => {
        expect(habitLicenceHeadline(matrix({ Power: [2, 1], Beginner: [30, 30] }))).toBe(
            "1 person without a licence was active on 11 or more days in March 2025.",
        );
    });

    it("says so when every heavy user had a licence", () => {
        expect(habitLicenceHeadline(matrix({ Power: [8, 0], Beginner: [10, 10] }))).toBe(
            "Everyone active on 11 or more days in March 2025 had a licence.",
        );
    });

    it("says so when nobody was that active", () => {
        expect(habitLicenceHeadline(matrix({ Beginner: [10, 10] }))).toBe(
            "Nobody was active on 11 or more days in March 2025.",
        );
    });

    it("doesn't compare a handful of people", () => {
        expect(habitLicenceHeadline(matrix({ Power: [1, 1], Beginner: [1, 0] }))).toBe(
            "Too few people were active in March 2025 to compare.",
        );
    });

    it("flags a roster that matched nobody instead of claiming everyone is unlicensed", () => {
        expect(habitLicenceHeadline(matrix({ Power: [0, 40], Beginner: [0, 100] }))).toMatch(/can't yet tell/);
    });

    it("says nothing with no data", () => {
        expect(habitLicenceHeadline(matrix({}))).toBeUndefined();
    });

    it("never claims a cause", () => {
        const cases = [
            matrix({ Power: [10, 4], Habitual: [20, 6] }),
            matrix({ Power: [2, 1], Beginner: [30, 30] }),
            matrix({ Power: [0, 40] }),
        ];
        for (const each of cases) expect(habitLicenceHeadline(each) ?? "").not.toMatch(CAUSAL_WORDS);
    });
});
