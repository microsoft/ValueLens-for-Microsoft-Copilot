//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { FEEDBACK_CATEGORY_HEADLINE, FEEDBACK_SURFACE_HEADLINE, FEEDBACK_TREND_HEADLINE } from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

const SURFACE = ["Surface / Agent", "Total Feedback", "Satisfaction"];

describe("feedback headlines", () => {
    it("names the busiest week, thumbs up and down together", () => {
        const trend = table(
            ["Week Start", "Feedback Type", "Count", "Signed Count"],
            [
                ["2026-05-04T00:00:00", "Thumbs Up", 12, 12],
                ["2026-05-04T00:00:00", "Thumbs Down", 4, -4],
                ["2026-05-11T00:00:00", "Thumbs Up", 20, 20],
                ["2026-05-11T00:00:00", "Thumbs Down", 3, -3],
            ],
        );
        const text = FEEDBACK_TREND_HEADLINE(trend);
        expect(text).toBe("Feedback items peaked in the week of 11 May 2026, at 23.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("names the category with the most feedback", () => {
        const categories = table(
            ["Category", "Feedback Type", "Count"],
            [
                ["Accuracy", "Thumbs Up", 30],
                ["Accuracy", "Thumbs Down", 10],
                ["Speed", "Thumbs Up", 10],
            ],
        );
        expect(FEEDBACK_CATEGORY_HEADLINE(categories)).toBe("Accuracy is the largest, at 80% of categorised feedback.");
    });

    it("sets the most and least satisfied surfaces side by side", () => {
        const surfaces = table(SURFACE, [
            ["Copilot Chat", 45, 0.78],
            ["Word", 20, 0.6],
            ["Teams", 10, 0.4],
        ]);
        const text = FEEDBACK_SURFACE_HEADLINE(surfaces);
        expect(text).toBe(
            "Copilot Chat has the highest satisfaction, at 78% across 45 feedback items; Teams has the lowest, at 40%.",
        );
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("leaves out surfaces with too few items to rank", () => {
        const surfaces = table(SURFACE, [
            ["Copilot Chat", 45, 0.78],
            ["Word", 3, 1],
            ["Teams", 10, 0.4],
        ]);
        expect(FEEDBACK_SURFACE_HEADLINE(surfaces)).toBe(
            "Copilot Chat has the highest satisfaction, at 78% across 45 feedback items; Teams has the lowest, at 40%.",
        );
        expect(FEEDBACK_SURFACE_HEADLINE(table(SURFACE, [["Copilot Chat", 45, 0.78], ["Word", 4, 0.1]]))).toBeUndefined();
    });

    it("says nothing for no rows, one surface or a tie", () => {
        expect(FEEDBACK_TREND_HEADLINE(table(["Week Start", "Count"], []))).toBeUndefined();
        expect(FEEDBACK_CATEGORY_HEADLINE(table(["Category", "Count"], [["Accuracy", 8]]))).toBeUndefined();
        expect(FEEDBACK_SURFACE_HEADLINE(table(SURFACE, []))).toBeUndefined();
        expect(FEEDBACK_SURFACE_HEADLINE(table(SURFACE, [["Copilot Chat", 45, 0.78]]))).toBeUndefined();
        expect(
            FEEDBACK_SURFACE_HEADLINE(
                table(SURFACE, [
                    ["Copilot Chat", 45, 0.781],
                    ["Word", 20, 0.779],
                    ["Teams", 10, 0.4],
                ]),
            ),
        ).toBeUndefined();
    });
});
