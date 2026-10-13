//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { budgetRunway, runwayHeadline, spreadWeeks, type DailySpend } from "./budget-runway";

function daily(from: string, count: number, cost: number): DailySpend[] {
    const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
    return Array.from({ length: count }, (_, i) => ({
        date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
        cost,
    }));
}

describe("budgetRunway", () => {
    it("reports no data for an empty series", () => {
        expect(budgetRunway([], 100).status).toBe("no-data");
    });

    it("runs the month to the last day with data, not to today", () => {
        const runway = budgetRunway(daily("2025-04-01", 10, 10), undefined);
        expect(runway).toMatchObject({
            status: "no-budget",
            asOf: "2025-04-10",
            monthStart: "2025-04-01",
            monthEnd: "2025-04-30",
            daysElapsed: 10,
            daysInMonth: 30,
            spent: 100,
            dailyAverage: 10,
            projected: 300,
        });
    });

    it("leaves earlier months out of month-to-date spend", () => {
        const runway = budgetRunway([...daily("2025-03-25", 7, 50), ...daily("2025-04-01", 5, 10)], 1000);
        expect(runway.spent).toBe(50);
        expect(runway.monthStart).toBe("2025-04-01");
    });

    it("counts days without spend as days elapsed", () => {
        const runway = budgetRunway([{ date: "2025-04-01", cost: 40 }, { date: "2025-04-04", cost: 0 }], 1000);
        expect(runway.daysElapsed).toBe(4);
        expect(runway.dailyAverage).toBe(10);
    });

    it("does not project from fewer than three days", () => {
        const runway = budgetRunway(daily("2025-04-01", 2, 10), 100);
        expect(runway.status).toBe("early");
        expect(runway.projected).toBeUndefined();
        expect(runway.crossesOn).toBeUndefined();
    });

    it("is on track when the projection stays within budget", () => {
        const runway = budgetRunway(daily("2025-04-01", 10, 10), 300);
        expect(runway.status).toBe("on-track");
        expect(runway.crossesOn).toBeUndefined();
    });

    it("projects the day spend passes the budget", () => {
        const runway = budgetRunway(daily("2025-04-01", 10, 10), 250);
        expect(runway.status).toBe("at-risk");
        expect(runway.crossesOn).toBe("2025-04-25");
    });

    it("reports the day spend passed the budget once it has", () => {
        const runway = budgetRunway(daily("2025-04-01", 10, 10), 45);
        expect(runway.status).toBe("over");
        expect(runway.crossesOn).toBe("2025-04-05");
    });

    it("is over even in the first days of a month", () => {
        expect(budgetRunway(daily("2025-04-01", 1, 500), 100).status).toBe("over");
    });

    it("treats a zero or missing budget as no budget", () => {
        expect(budgetRunway(daily("2025-04-01", 5, 10), 0).status).toBe("no-budget");
        expect(budgetRunway(daily("2025-04-01", 5, 10), Number.NaN).status).toBe("no-budget");
    });

    it("handles a month that ends on its last day", () => {
        const runway = budgetRunway(daily("2024-02-01", 29, 1), 100);
        expect(runway).toMatchObject({ daysInMonth: 29, daysElapsed: 29, projected: 29, status: "on-track" });
    });

    it("skips rows without a usable date or cost", () => {
        const runway = budgetRunway([{ date: "", cost: 5 }, { date: "2025-04-03", cost: Number.NaN }, { date: "2025-04-03", cost: 9 }], undefined);
        expect(runway.spent).toBe(9);
    });
});

describe("runwayHeadline", () => {
    it("says plainly when there is nothing to report", () => {
        expect(runwayHeadline(budgetRunway([], 100), "$")).toBe("No spend recorded yet.");
        expect(runwayHeadline(budgetRunway(daily("2025-04-01", 2, 10), undefined), "$")).toBe("No budget set.");
    });

    it("does not project early in the month", () => {
        expect(runwayHeadline(budgetRunway(daily("2025-04-01", 1, 10), 100), "$")).toBe(
            "Only 1 day into the month, too early to project.",
        );
    });

    it("words the projection as a pace, not a forecast", () => {
        expect(runwayHeadline(budgetRunway(daily("2025-04-01", 10, 10), 250), "$")).toBe(
            "At this pace, spend passes the budget around 25 Apr and ends the month near $300.",
        );
        expect(runwayHeadline(budgetRunway(daily("2025-04-01", 10, 10), 400), "£")).toBe(
            "On track. At this pace the month ends near £300 by 30 Apr, 75% of budget.",
        );
        expect(runwayHeadline(budgetRunway(daily("2025-04-01", 10, 10), undefined), "$")).toBe(
            "No budget set. At this pace the month ends near $300.",
        );
    });

    it("hedges the day a weekly source passed its budget", () => {
        const runway = budgetRunway(daily("2025-04-01", 10, 10), 45);
        expect(runwayHeadline(runway, "$")).toBe("Spend passed the budget on 5 Apr.");
        expect(runwayHeadline(runway, "$", true)).toBe("Spend passed the budget around 5 Apr.");
    });
});

describe("spreadWeeks", () => {
    it("spreads each week over seven days", () => {
        const days = spreadWeeks([{ start: "2025-03-29", cost: 70 }]);
        expect(days).toHaveLength(7);
        expect(days[0]).toEqual({ date: "2025-03-29", cost: 10 });
        expect(days[6]).toEqual({ date: "2025-04-04", cost: 10 });
    });

    it("splits a week that straddles two months between them", () => {
        const runway = budgetRunway(spreadWeeks([{ start: "2025-03-29", cost: 70 }]), undefined);
        expect(runway.asOf).toBe("2025-04-04");
        expect(runway.spent).toBe(40);
    });
});
