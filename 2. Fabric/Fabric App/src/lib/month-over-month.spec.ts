//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    addMonths,
    daysInMonth,
    monthDelta,
    monthEnd,
    monthOf,
    monthOverMonth,
    trendWindow,
} from "./month-over-month";

describe("month arithmetic", () => {
    it("finds the month a date falls in", () => {
        expect(monthOf("2026-07-15")).toBe("2026-07-01");
        expect(monthOf("2026-07-01T00:00:00")).toBe("2026-07-01");
    });

    it("steps across year ends both ways", () => {
        expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
        expect(addMonths("2025-11-01", 3)).toBe("2026-02-01");
    });

    it("knows each month's length, leap years included", () => {
        expect(daysInMonth("2026-06-01")).toBe(30);
        expect(daysInMonth("2026-07-01")).toBe(31);
        expect(daysInMonth("2026-02-01")).toBe(28);
        expect(daysInMonth("2028-02-01")).toBe(29);
        expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    });
});

describe("trendWindow", () => {
    it("always spans six months ending with the range's last month", () => {
        const window = trendWindow("2026-05-12", "2026-07-08");
        expect(window.months).toEqual([
            "2026-02-01",
            "2026-03-01",
            "2026-04-01",
            "2026-05-01",
            "2026-06-01",
            "2026-07-01",
        ]);
        expect(window.from).toBe("2026-02-01");
        expect(window.to).toBe("2026-07-08");
    });

    it("fades from the month the range starts in, not the day", () => {
        expect(trendWindow("2026-05-12", "2026-07-08").rangeMonth).toBe("2026-05-01");
    });

    it("keeps six months when the range is longer", () => {
        const window = trendWindow("2025-01-01", "2026-07-08");
        expect(window.months).toHaveLength(6);
        expect(window.rangeMonth < window.from).toBe(true);
    });
});

describe("monthOverMonth", () => {
    it("compares the last full month with the one before it", () => {
        expect(monthOverMonth("2026-04-22", "2026-07-08")).toEqual({ current: "2026-06-01", previous: "2026-05-01" });
    });

    it("counts the range's last month when the range ends on its last day", () => {
        expect(monthOverMonth("2026-05-01", "2026-06-30")).toEqual({ current: "2026-06-01", previous: "2026-05-01" });
    });

    it("gives no comparison with fewer than two full months", () => {
        expect(monthOverMonth("2026-05-02", "2026-07-08")).toBeUndefined();
        expect(monthOverMonth("2026-06-01", "2026-06-30")).toBeUndefined();
        expect(monthOverMonth("2026-06-10", "2026-06-20")).toBeUndefined();
    });

    it("crosses a year end", () => {
        expect(monthOverMonth("2025-11-01", "2026-01-15")).toEqual({ current: "2025-12-01", previous: "2025-11-01" });
    });

    it("rejects a range that ends before it starts", () => {
        expect(monthOverMonth("2026-07-01", "2026-05-01")).toBeUndefined();
    });
});

describe("monthDelta", () => {
    const juneVsMay = { current: "2026-06-01", previous: "2026-05-01" };

    it("compares volumes per day, so a 31-day month doesn't win by length", () => {
        // 300 over June's 30 days is 10 a day; 310 over May's 31 days is also 10.
        expect(monthDelta("volume", juneVsMay, 300, 310)).toEqual({
            direction: "flat",
            amount: "No change",
            comparison: "Jun vs May, per day",
        });
        expect(monthDelta("volume", juneVsMay, 783, 597)).toEqual({
            direction: "up",
            amount: "36%",
            comparison: "Jun vs May, per day",
        });
    });

    it("compares rates in percentage points", () => {
        expect(monthDelta("rate", juneVsMay, 0.2165, 0.1526)).toEqual({
            direction: "up",
            amount: "6.4 pp",
            comparison: "Jun vs May",
        });
        expect(monthDelta("rate", juneVsMay, 0.61, 0.65)?.direction).toBe("down");
    });

    it("compares averages as a plain difference", () => {
        expect(monthDelta("average", juneVsMay, 3.43, 4.2)).toEqual({
            direction: "down",
            amount: "0.8",
            comparison: "Jun vs May",
        });
    });

    it("calls a change that prints as zero flat", () => {
        expect(monthDelta("rate", juneVsMay, 0.6578, 0.6577)?.direction).toBe("flat");
        expect(monthDelta("average", juneVsMay, 4.02, 4.0)?.amount).toBe("No change");
    });

    it("gives nothing when a month has no figure", () => {
        expect(monthDelta("rate", juneVsMay, 0.5, null)).toBeUndefined();
        expect(monthDelta("volume", juneVsMay, undefined, 10)).toBeUndefined();
        expect(monthDelta("volume", juneVsMay, 10, 0)).toBeUndefined();
    });
});
