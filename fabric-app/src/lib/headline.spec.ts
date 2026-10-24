//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS, firstHeadline, leaderHeadline, MIN_PEOPLE, peakHeadline, shareText, splitHeadline } from "./headline";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

const empty = table(["Product", "Credits"], []);

describe("shareText", () => {
    it("never rounds a real share to nothing or a remainder to everything", () => {
        expect(shareText(1, 1000)).toBe("under 1%");
        expect(shareText(999, 1000)).toBe("over 99%");
        expect(shareText(1, 4)).toBe("25%");
    });
});

describe("leaderHeadline", () => {
    const leader = leaderHeadline({ label: "Product", value: "Credits", of: "credits" });

    it("names the largest category and its share", () => {
        const products = table(
            ["Product", "Credits"],
            [
                ["Copilot Studio", 60],
                ["Cowork", 30],
                ["Copilot Studio", 0],
                ["Azure", 10],
            ],
        );
        expect(leader(products)).toBe("Copilot Studio is the largest, at 60% of credits.");
    });

    it("says nothing for empty data, one category, a tie or a zero total", () => {
        expect(leader(empty)).toBeUndefined();
        expect(leader(table(["Product", "Credits"], [["Cowork", 5]]))).toBeUndefined();
        expect(leader(table(["Product", "Credits"], [["A", 5], ["B", 5]]))).toBeUndefined();
        expect(leader(table(["Product", "Credits"], [["A", 0], ["B", 0]]))).toBeUndefined();
        expect(leader(table(["Product", "Credits"], [["A", 5], ["B", -2]]))).toBeUndefined();
    });

    it("won't rank too few people", () => {
        const people = leaderHeadline({ label: "Person", value: "Hours", of: "hours", minCategories: MIN_PEOPLE });
        const four = table(["Person", "Hours"], [["a", 4], ["b", 3], ["c", 2], ["d", 1]]);
        expect(people(four)).toBeUndefined();
        const five = table(["Person", "Hours"], [["a", 5], ["b", 4], ["c", 3], ["d", 2], ["e", 1]]);
        expect(people(five)).toBe("a is the largest, at 33% of hours.");
    });
});

describe("peakHeadline", () => {
    const peak = peakHeadline({ date: "Week Start", value: "Credits", of: "credits", period: "week" });

    it("names the highest period, summing rows that share a date", () => {
        const weeks = table(
            ["Week Start", "Credits"],
            [
                ["2025-05-05T00:00:00", 600],
                ["2025-05-05T00:00:00", 640],
                ["2025-05-12T00:00:00", 900],
            ],
        );
        expect(peak(weeks)).toBe("Credits peaked in the week of 5 May 2025, at 1,240.");
    });

    it("says nothing with fewer than two periods", () => {
        expect(peak(empty)).toBeUndefined();
        expect(peak(table(["Week Start", "Credits"], [["2025-05-05T00:00:00", 600]]))).toBeUndefined();
        expect(peak(table(["Week Start", "Credits"], [["2025-05-05", 0], ["2025-05-12", 0]]))).toBeUndefined();
    });

    it("formats money and months", () => {
        const monthly = peakHeadline({ date: "Month", value: "Cost", of: "cost", period: "month", format: "currency", prefix: "$" });
        expect(monthly(table(["Month", "Cost"], [["2025-04-01", 10], ["2025-05-01", 1200.4]]))).toBe(
            "Cost peaked in May 2025, at $1,200.",
        );
    });
});

describe("splitHeadline", () => {
    const split = splitHeadline({
        parts: [
            { column: "Prepaid Cost", label: "prepaid" },
            { column: "PAYG Cost", label: "pay-as-you-go" },
        ],
        of: "the cost",
    });

    it("gives the larger part's share of the whole", () => {
        expect(split(table(["Prepaid Cost", "PAYG Cost"], [[30, 10], [34, 26]]))).toBe("Prepaid makes up 64% of the cost.");
        expect(split(table(["Prepaid Cost", "PAYG Cost"], [[30, 0]]))).toBe("Prepaid is all of the cost.");
    });

    it("says nothing without a positive total", () => {
        expect(split(table(["Prepaid Cost", "PAYG Cost"], []))).toBeUndefined();
        expect(split(table(["Prepaid Cost", "PAYG Cost"], [[0, 0]]))).toBeUndefined();
    });
});

describe("firstHeadline", () => {
    it("falls through to the next builder with something to say", () => {
        const headline = firstHeadline(
            () => undefined,
            () => "Second.",
        );
        expect(headline(empty)).toBe("Second.");
        expect(firstHeadline(() => undefined)(empty)).toBeUndefined();
    });
});

describe("headline wording", () => {
    it("describes rather than explains", () => {
        const sentences = [
            leaderHeadline({ label: "Product", value: "Credits", of: "credits" })(table(["Product", "Credits"], [["A", 3], ["B", 1]])),
            peakHeadline({ date: "Day", value: "Credits", of: "credits", period: "day" })(table(["Day", "Credits"], [["2025-05-01", 3], ["2025-05-02", 1]])),
        ];
        for (const sentence of sentences) {
            expect(sentence).toBeDefined();
            expect(sentence).not.toMatch(CAUSAL_WORDS);
        }
        expect("Usage rose because of training").toMatch(CAUSAL_WORDS);
        expect(sentences[1]).toBe("Credits peaked on 1 May 2025, at 3.");
    });
});
