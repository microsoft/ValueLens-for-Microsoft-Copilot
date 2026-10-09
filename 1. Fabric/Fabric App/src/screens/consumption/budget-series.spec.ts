//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { azureDailySpend, coworkWeeklySpend, earlierDate, studioDailySpend } from "./budget-series";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

describe("budget series", () => {
    it("adds prepaid and pay-as-you-go cost per day", () => {
        const studio = table(
            ["Usage Date", "Credits", "Prepaid Cost", "PAYG Cost"],
            [
                ["2025-04-01T00:00:00", 10, 1.5, 2],
                ["2025-04-02T00:00:00", 10, null, 3],
                ["2025-04-03T00:00:00", 10, null, null],
            ],
        );
        expect(studioDailySpend(studio)).toEqual([
            { date: "2025-04-01", cost: 3.5 },
            { date: "2025-04-02", cost: 3 },
        ]);
    });

    it("reads Cowork by the week it starts", () => {
        const cowork = table(["Week Index", "Week Start", "Prepaid Cost", "PAYG Cost"], [[1, "2025-03-31T00:00:00", 7, 0]]);
        expect(coworkWeeklySpend(cowork)).toEqual([{ start: "2025-03-31", cost: 7 }]);
    });

    it("adds the Azure components of a day together", () => {
        const azure = table(
            ["Usage Date", "Component", "Component Sort", "Cost"],
            [
                ["2025-04-01T00:00:00", "Models", 1, 4],
                ["2025-04-01T00:00:00", "Supporting", 3, 1],
                ["2025-04-02T00:00:00", "Models", 1, 2],
            ],
        );
        expect(azureDailySpend(azure)).toEqual([
            { date: "2025-04-01", cost: 5 },
            { date: "2025-04-02", cost: 2 },
        ]);
    });

    it("returns nothing for a missing table", () => {
        expect(studioDailySpend(undefined)).toEqual([]);
        expect(coworkWeeklySpend(undefined)).toEqual([]);
        expect(azureDailySpend(undefined)).toEqual([]);
    });

    it("picks the earlier date", () => {
        expect(earlierDate("2025-04-06", "2025-04-03")).toBe("2025-04-03");
        expect(earlierDate(undefined, "2025-04-03")).toBe("2025-04-03");
        expect(earlierDate("2025-04-06", undefined)).toBe("2025-04-06");
    });
});
