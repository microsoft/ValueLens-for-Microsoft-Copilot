//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { adoptionTrendHeadline, habitMixHeadline, perUserHeadline } from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

const WEEK = "Chat + Agent Interactions (Audit Logs)WeekStart";
const trendColumns = [WEEK, "Licensed", "Unlicensed", "Agents", "All Sessions", "Hours"];
const trend = table(trendColumns, [
    ["2026-05-04T00:00:00", 3.0, 1.2, 2.0, 900, 40.5],
    ["2026-05-11T00:00:00", 3.4, 1.6, 2.2, 1240, 62.25],
    ["2026-05-18T00:00:00", 3.2, 1.4, 2.1, 1100, 51],
]);
const plenty = { Licensed: 120, Unlicensed: 80, Agents: 40 };

describe("perUserHeadline", () => {
    it("compares the highest and lowest weekly averages without claiming a cause", () => {
        const text = perUserHeadline(plenty)(trend);
        expect(text).toBe(
            "Sessions per user are highest for licensed chat, at 3.20 a week against 1.40 for unlicensed chat. A comparison, not a cause.",
        );
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("leaves out a surface used by too few people", () => {
        expect(perUserHeadline({ ...plenty, Licensed: 3 })(trend)).toBe(
            "Sessions per user are highest for agents, at 2.10 a week against 1.40 for unlicensed chat. A comparison, not a cause.",
        );
    });

    it("says nothing with one surface left, no weeks, one week or a tie", () => {
        expect(perUserHeadline({ Licensed: 120 })(trend)).toBeUndefined();
        expect(perUserHeadline(plenty)(table(trendColumns, []))).toBeUndefined();
        expect(perUserHeadline(plenty)(table(trendColumns, [trend.rows[0]]))).toBeUndefined();
        const tied = table(trendColumns, [
            [trend.rows[0][0], 2, 2, 1, 0, 0],
            [trend.rows[1][0], 2, 2, 1, 0, 0],
        ]);
        expect(perUserHeadline(plenty)(tied)).toBeUndefined();
    });
});

describe("adoptionTrendHeadline", () => {
    it("follows the measure the chart is drawn in", () => {
        expect(adoptionTrendHeadline("sessions", plenty)(trend)).toBe("Sessions peaked in the week of 11 May 2026, at 1,240.");
        expect(adoptionTrendHeadline("hours", plenty)(trend)).toBe(
            "Expert-equivalent hours peaked in the week of 11 May 2026, at 62.3.",
        );
        expect(adoptionTrendHeadline("sessionsPerUser", plenty)(trend)).toMatch(/^Sessions per user are highest for licensed chat/);
    });

    it("says nothing for an empty or single-week trend", () => {
        expect(adoptionTrendHeadline("sessions", plenty)(table(trendColumns, []))).toBeUndefined();
        expect(adoptionTrendHeadline("hours", plenty)(table(trendColumns, [trend.rows[0]]))).toBeUndefined();
    });
});

describe("habitMixHeadline", () => {
    const MONTH = "Chat + Agent Interactions (Audit Logs)MonthStart";
    const columns = [MONTH, "Stage LegendStage", "Users"];
    const mix = table(columns, [
        ["2026-01-01T00:00:00", "0 - Inactive", 50],
        ["2026-01-01T00:00:00", "4 - Power", 8],
        ["2026-01-01T00:00:00", "2 - Building", 42],
        ["2026-02-01T00:00:00", "0 - Inactive", 48],
        ["2026-02-01T00:00:00", "4 - Power", 10],
        ["2026-02-01T00:00:00", "2 - Building", 42],
        ["2026-03-01T00:00:00", "0 - Inactive", 40],
        ["2026-03-01T00:00:00", "4 - Power", 20],
        ["2026-03-01T00:00:00", "2 - Building", 40],
    ]);

    it("names the stage that moved most in share", () => {
        const text = habitMixHeadline("share")(mix);
        expect(text).toBe("The Power stage rose from 8% to 20% of users between January 2026 and March 2026.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("names the stage that moved most in users on the count scale", () => {
        expect(habitMixHeadline("count")(mix)).toBe(
            "The Power stage rose from 8 to 20 users between January 2026 and March 2026.",
        );
    });

    it("says nothing for no rows, one month, too few people, a tie or no movement", () => {
        expect(habitMixHeadline("share")(table(columns, []))).toBeUndefined();
        expect(habitMixHeadline("share")(table(columns, mix.rows.slice(0, 3)))).toBeUndefined();
        const few = table(columns, [
            ["2026-01-01T00:00:00", "4 - Power", 1],
            ["2026-01-01T00:00:00", "0 - Inactive", 2],
            ["2026-02-01T00:00:00", "4 - Power", 3],
            ["2026-02-01T00:00:00", "0 - Inactive", 1],
        ]);
        expect(habitMixHeadline("share")(few)).toBeUndefined();
        const tied = table(columns, [
            ["2026-01-01T00:00:00", "4 - Power", 10],
            ["2026-01-01T00:00:00", "0 - Inactive", 10],
            ["2026-02-01T00:00:00", "4 - Power", 15],
            ["2026-02-01T00:00:00", "0 - Inactive", 5],
        ]);
        expect(habitMixHeadline("count")(tied)).toBeUndefined();
        const still = table(columns, [
            ["2026-01-01T00:00:00", "4 - Power", 10],
            ["2026-01-01T00:00:00", "0 - Inactive", 10],
            ["2026-02-01T00:00:00", "4 - Power", 10],
            ["2026-02-01T00:00:00", "0 - Inactive", 10],
        ]);
        expect(habitMixHeadline("share")(still)).toBeUndefined();
    });
});
