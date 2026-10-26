//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { COWORK_TASK_HEADLINE, MATCH_BY_TOOL_HEADLINE, MODEL_USAGE_HEADLINE } from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

const MATCH = ["Activity", "Outcome", "Sessions"];

describe("efficiency headlines", () => {
    it("names the task with the most graded sessions, across its grades", () => {
        const tasks = table(
            ["Task", "Fit", "Sessions"],
            [
                ["Drafting", "Good fit", 30],
                ["Drafting", "Poor fit", 10],
                ["Research", "Good fit", 20],
                ["Scheduling", "Good fit", 20],
            ],
        );
        const text = COWORK_TASK_HEADLINE(tasks);
        expect(text).toBe("Drafting is the largest, at 50% of graded sessions.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("names the model behind the most sessions, across its tiers", () => {
        const models = table(
            ["Model", "Tier", "Sessions"],
            [
                ["Model A", "Standard", 50],
                ["Model A", "Premium", 25],
                ["Model B", "Standard", 25],
            ],
        );
        expect(MODEL_USAGE_HEADLINE(models)).toBe("Model A is the largest, at 75% of sessions with a logged model.");
    });

    it("compares the tools' good-match shares as a comparison, not a cause", () => {
        const match = table(MATCH, [
            ["Agents", "Good match", 66],
            ["Agents", "Overkill", 34],
            ["Copilot", "Good match", 40],
            ["Copilot", "Overkill", 60],
        ]);
        const text = MATCH_BY_TOOL_HEADLINE(match);
        expect(text).toBe(
            "Good matches make up 66% of Agents sessions, against 40% of Copilot sessions. A comparison, not a cause.",
        );
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("falls back to the commonest outcome when the tools tie or one has too few sessions", () => {
        const tied = table(MATCH, [
            ["Agents", "Good match", 66],
            ["Agents", "Overkill", 34],
            ["Copilot", "Good match", 33],
            ["Copilot", "Overkill", 17],
        ]);
        expect(MATCH_BY_TOOL_HEADLINE(tied)).toBe("Good match is the largest, at 66% of sessions.");

        const thin = table(MATCH, [
            ["Agents", "Good match", 60],
            ["Agents", "Overkill", 20],
            ["Copilot", "Overkill", 4],
        ]);
        expect(MATCH_BY_TOOL_HEADLINE(thin)).toBe("Good match is the largest, at 71% of sessions.");
    });

    it("says nothing for no rows or a single category", () => {
        expect(COWORK_TASK_HEADLINE(table(["Task", "Sessions"], []))).toBeUndefined();
        expect(MODEL_USAGE_HEADLINE(table(["Model", "Sessions"], [["Model A", 9]]))).toBeUndefined();
        expect(MATCH_BY_TOOL_HEADLINE(table(MATCH, []))).toBeUndefined();
        expect(MATCH_BY_TOOL_HEADLINE(table(MATCH, [["Agents", "Good match", 3]]))).toBeUndefined();
    });
});
