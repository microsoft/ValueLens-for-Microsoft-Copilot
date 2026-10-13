//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import {
    ARCHETYPE_HEADLINE,
    ERROR_HEADLINE,
    SOURCE_HEADLINE,
    THEME_HEADLINE,
    WEEKLY_OUTCOME_HEADLINE,
} from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

describe("agent evaluation headlines", () => {
    it("names the busiest theme across its outcomes", () => {
        const themes = table(
            ["Theme", "Outcome", "Conversations"],
            [
                ["Expenses", "Resolved", 40],
                ["Expenses", "Abandoned", 20],
                ["Travel", "Resolved", 30],
                ["Leave", "Resolved", 10],
            ],
        );
        const text = THEME_HEADLINE(themes);
        expect(text).toBe("Expenses is the largest, at 60% of conversations.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("names the most cited source and the commonest answer archetype", () => {
        expect(SOURCE_HEADLINE(table(["Source", "Citations"], [["Intranet", 75], ["Wiki", 25]]))).toBe(
            "Intranet is the largest, at 75% of the citations shown.",
        );
        expect(ARCHETYPE_HEADLINE(table(["Archetype", "Conversations"], [["Grounded", 9], ["General", 1]]))).toBe(
            "Grounded is the largest, at 90% of conversations.",
        );
    });

    it("names the commonest ending, or the busiest week when every conversation ended one way", () => {
        const columns = ["Week Start", "Outcome", "Conversations"];
        const mixed = table(columns, [
            ["2026-05-04T00:00:00", "Resolved", 30],
            ["2026-05-04T00:00:00", "Escalated", 10],
            ["2026-05-11T00:00:00", "Resolved", 40],
            ["2026-05-11T00:00:00", "Escalated", 20],
        ]);
        expect(WEEKLY_OUTCOME_HEADLINE(mixed)).toBe("Resolved is the largest, at 70% of conversations.");

        const oneEnding = table(columns, [
            ["2026-05-04T00:00:00", "Resolved", 30],
            ["2026-05-11T00:00:00", "Resolved", 45],
        ]);
        const text = WEEKLY_OUTCOME_HEADLINE(oneEnding);
        expect(text).toBe("Conversations peaked in the week of 11 May 2026, at 45.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("names the commonest error across both who hit them", () => {
        const errors = table(
            ["Error Code", "Who", "Errors"],
            [
                ["Timeout", "Users", 6],
                ["Timeout", "Makers", 2],
                ["Throttled", "Users", 2],
            ],
        );
        expect(ERROR_HEADLINE(errors)).toBe("Timeout is the largest, at 80% of the errors shown.");
    });

    it("says nothing for no rows, a single category or a tie", () => {
        expect(THEME_HEADLINE(table(["Theme", "Conversations"], []))).toBeUndefined();
        expect(SOURCE_HEADLINE(table(["Source", "Citations"], [["Intranet", 12]]))).toBeUndefined();
        expect(ERROR_HEADLINE(table(["Error Code", "Errors"], [["A", 3], ["B", 3]]))).toBeUndefined();
        expect(WEEKLY_OUTCOME_HEADLINE(table(["Week Start", "Outcome", "Conversations"], []))).toBeUndefined();
        expect(
            WEEKLY_OUTCOME_HEADLINE(table(["Week Start", "Outcome", "Conversations"], [["2026-05-04T00:00:00", "Resolved", 4]])),
        ).toBeUndefined();
    });
});
