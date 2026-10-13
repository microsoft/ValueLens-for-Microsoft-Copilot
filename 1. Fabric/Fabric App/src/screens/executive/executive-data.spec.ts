//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { QueryTable } from "@microsoft/fabric-app-data";
import type { SummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { executiveMonths } from "@/queries/executive";
import monthRows from "@/queries/executive/__fixtures__/executive-months.rows.json";
import summaryRows from "@/queries/executive/__fixtures__/executive-summary.rows.json";
import {
    byMonth,
    cardDelta,
    executiveRange,
    formatDay,
    formatMonth,
    joinNames,
    mostUsedAgent,
    ratio,
    sumPresent,
    tableRecords,
    workRates,
} from "./executive-data";

type Row = Record<string, string | number | boolean | null>;

const summary = summaryRows[0] as SummaryRow;

function monthRecords(): SummaryRow[] {
    const rows = monthRows as Row[];
    const names = Object.keys(rows[0]);
    const table = {
        columns: names.map((name) => ({ name, dataType: "string" })),
        rows: rows.map((row) => names.map((name) => row[name])),
    } as QueryTable;
    return tableRecords(toDataTable(table, executiveMonths().columnMetadata));
}

describe("executiveRange", () => {
    it("holds the range to the days with activity", () => {
        const range = executiveRange("2026-01-01", "2026-12-31", "2026-05-08", "2026-07-06");
        expect(range?.start).toBe("2026-05-08");
        expect(range?.end).toBe("2026-07-06");
        expect(range?.window.months).toHaveLength(6);
        expect(range?.window.rangeMonth).toBe("2026-05-01");
    });

    it("keeps a narrower range as chosen", () => {
        const range = executiveRange("2026-05-20", "2026-06-10", "2026-05-08", "2026-07-06");
        expect([range?.start, range?.end]).toEqual(["2026-05-20", "2026-06-10"]);
    });

    it("hides the arrows on the demo range, which holds only one full month", () => {
        expect(executiveRange(undefined, undefined, "2026-05-08", "2026-07-06")?.pair).toBeUndefined();
    });

    it("compares the last two full months once the range holds them", () => {
        expect(executiveRange("2026-05-01", "2026-07-06", "2026-04-01", "2026-07-06")?.pair).toEqual({
            current: "2026-06-01",
            previous: "2026-05-01",
        });
    });

    it("has nothing to show without activity dates or once the range misses them", () => {
        expect(executiveRange("2026-05-01", "2026-06-30", undefined, "2026-07-06")).toBeUndefined();
        expect(executiveRange("2026-05-01", "2026-06-30", "2026-05-08", undefined)).toBeUndefined();
        expect(executiveRange("2026-08-01", "2026-08-31", "2026-05-08", "2026-07-06")).toBeUndefined();
    });
});

describe("cardDelta on the demo months", () => {
    const months = byMonth(monthRecords());
    const pair = { current: "2026-06-01", previous: "2026-05-01" };
    const read = (column: string) => (row: SummaryRow | undefined) => {
        const value = row?.[column];
        return typeof value === "number" ? value : undefined;
    };

    it("keys the months by their first day", () => {
        expect([...months.keys()]).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    });

    it("compares volumes per day, so June's 30 days aren't held against May's 31", () => {
        expect(cardDelta("volume", pair, months, read("Hours"))).toEqual({
            direction: "up",
            amount: "36%",
            comparison: "Jun vs May, per day",
        });
    });

    it("compares rates in percentage points and averages as a plain difference", () => {
        expect(cardDelta("rate", pair, months, read("Habit Pct"))).toMatchObject({ direction: "up", amount: "6.4 pp" });
        expect(cardDelta("average", pair, months, read("Skills Per Person"))).toMatchObject({
            direction: "down",
            amount: "0.8",
            comparison: "Jun vs May",
        });
    });

    it("carries a neutral polarity through for credits", () => {
        expect(cardDelta("volume", pair, months, read("Tasks"), "neutral")?.polarity).toBe("neutral");
    });

    it("draws no arrow without two full months or a figure for each", () => {
        expect(cardDelta("volume", undefined, months, read("Hours"))).toBeUndefined();
        expect(cardDelta("volume", pair, months, read("Cowork Hours"))).toBeUndefined();
        expect(cardDelta("volume", { current: "2026-09-01", previous: "2026-08-01" }, months, read("Hours"))).toBeUndefined();
    });
});

describe("workRates on the demo summary", () => {
    it("works out the per-person, per-task and agent figures", () => {
        const rates = workRates(summary);
        expect(rates.minutesPerPersonWeek).toBeCloseTo((1541.5333 * 60) / 1800, 2);
        expect(rates.tasksPerPersonWeek).toBeCloseTo(3.5, 5);
        expect(rates.minutesPerTask).toBeCloseTo((1541.5333 * 60) / 6300, 3);
        expect(rates.agentShare).toBeCloseTo(1090.8 / 1541.5333, 5);
        expect(rates.habitRate).toBeCloseTo(0.2165, 4);
    });

    it("leaves every figure blank without a summary", () => {
        expect(workRates(undefined)).toEqual({
            minutesPerPersonWeek: undefined,
            tasksPerPersonWeek: undefined,
            minutesPerTask: undefined,
            agentShare: undefined,
            habitRate: undefined,
        });
    });

    it("never divides by zero people", () => {
        expect(workRates({ ...summary, "[People]": 0 }).minutesPerPersonWeek).toBeUndefined();
    });
});

describe("small helpers", () => {
    it("divides and adds only what is there", () => {
        expect(ratio(3, 4)).toBe(0.75);
        expect(ratio(3, 0)).toBeUndefined();
        expect(ratio(undefined, 4)).toBeUndefined();
        expect(sumPresent(1, undefined, 2)).toBe(3);
        expect(sumPresent(undefined, undefined)).toBeUndefined();
    });

    it("names the most used agent, or every agent tied for it", () => {
        expect(mostUsedAgent(summary)).toBe("Copilot for Excel, Copilot for Teams and Finance Analyst Bot, tied on users");
        expect(mostUsedAgent({ "[Agent With Most Users]": "Finance Analyst Bot" })).toBe("Finance Analyst Bot");
        expect(mostUsedAgent({ "[Agent With Most Users]": null })).toBeUndefined();
        expect(joinNames(["A", "B"])).toBe("A and B");
    });

    it("prints days and months the way the page does", () => {
        expect(formatDay("2026-07-06T00:00:00")).toBe("6 Jul 2026");
        expect(formatMonth(summary["[Habit Month]"])).toBe("June");
        expect(formatDay(45000)).toBeUndefined();
        expect(formatMonth("June")).toBeUndefined();
    });
});