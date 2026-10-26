//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { HOURS_PER_WEEK_COLUMN, TASK_CATEGORY_COLUMN, TASK_GROUP_COLUMN } from "@/queries/value";
import {
    agentCoverageHeadline,
    largestHeadline,
    MODEL_HEADLINE,
    pairReturnHeadline,
    rowsWhere,
    SURFACE_HEADLINE,
    TASK_BREAKDOWN_HEADLINES,
    TIME_SAVED_HEADLINE,
} from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

describe("rowsWhere", () => {
    it("reads only the rows of the one lens", () => {
        const seen: number[] = [];
        const headline = rowsWhere("Lens", "Model", (rows) => {
            seen.push(rows.rows.length);
            return undefined;
        });
        headline(table(["Lens", "Category"], [["Surface", "Teams"], ["Model", "GPT-4o"], ["Model", "o3"]]));
        expect(seen).toEqual([2]);
        expect(rowsWhere("Missing", "Model", () => "never")(table(["Lens"], [["Model"]]))).toBeUndefined();
    });
});

describe("largestHeadline", () => {
    const largest = largestHeadline({ label: "Task", value: "Hours", of: "expert-equivalent hours a week", format: "hours" });

    it("names the largest row and its own figure, with no share", () => {
        const text = largest(table(["Task", "Hours"], [["Drafting", 12.34], ["Summarising", 8], ["Searching", 3]]));
        expect(text).toBe(`Drafting has the most expert-equivalent hours a week, at ${(12.3).toLocaleString()}.`);
        expect(text).not.toMatch(/%/);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no rows, one row, a tie or a negative value", () => {
        expect(largest(table(["Task", "Hours"], []))).toBeUndefined();
        expect(largest(table(["Task", "Hours"], [["Drafting", 12]]))).toBeUndefined();
        expect(largest(table(["Task", "Hours"], [["Drafting", 12], ["Summarising", 0]]))).toBeUndefined();
        expect(largest(table(["Task", "Hours"], [["Drafting", 12], ["Summarising", 12]]))).toBeUndefined();
        expect(largest(table(["Task", "Hours"], [["Drafting", 12], ["Summarising", -1]]))).toBeUndefined();
    });
});

const PAIR_COLUMNS = ["Pair", "Cost Line", "Cost", "Set Against", "Value", "Return", "Sort"];

describe("pairReturnHeadline", () => {
    it("names the cost with the most estimated value against it, as a comparison", () => {
        const text = pairReturnHeadline(
            table(PAIR_COLUMNS, [
                ["Licences → Licensed users' Copilot", "Microsoft 365 Copilot licences", 9000, "Licensed users' Copilot", 27000, 3, 0],
                ["Studio credits → Agents", "Copilot Studio credits", 1000, "Agents", 5400, 5.4, 1],
                ["Cowork credits → Cowork", "Cowork / Work IQ credits", 500, "Cowork", 250, 0.5, 2],
            ]),
        );
        expect(text).toBe(
            `Estimated value is highest relative to cost for Copilot Studio credits, at ${(5.4).toLocaleString(undefined, { minimumFractionDigits: 1 })}×.`,
        );
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no pairs, one pair with a return, or a tie", () => {
        expect(pairReturnHeadline(table(PAIR_COLUMNS, []))).toBeUndefined();
        expect(
            pairReturnHeadline(
                table(PAIR_COLUMNS, [
                    ["Licences", "Microsoft 365 Copilot licences", 9000, "Licensed users' Copilot", 27000, 3, 0],
                    ["Studio", "Copilot Studio credits", null, "Agents", 5400, null, 1],
                ]),
            ),
        ).toBeUndefined();
        expect(
            pairReturnHeadline(
                table(PAIR_COLUMNS, [
                    ["Licences", "Microsoft 365 Copilot licences", 100, "Licensed users' Copilot", 200, 2, 0],
                    ["Studio", "Copilot Studio credits", 100, "Agents", 200, 2, 1],
                ]),
            ),
        ).toBeUndefined();
    });
});

const AGENT_COLUMNS = ["Pair", "Share", "Cost", "Sessions", "Value", "Return", "Sort"];

describe("agentCoverageHeadline", () => {
    const agent = (name: string, ratio: number | null) => [name, 0.2, 100, 10, ratio === null ? null : ratio * 100, ratio, 0];

    it("counts the agents whose value is at or above their cost", () => {
        const text = agentCoverageHeadline(
            table(AGENT_COLUMNS, [agent("HR helper", 2), agent("IT helper", 1), agent("Sales helper", 0.4), agent("Unpriced", null)]),
        );
        expect(text).toBe("Estimated value is at or above the allocated cost for 2 of 3 agents.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("reads naturally when it is all or none", () => {
        expect(agentCoverageHeadline(table(AGENT_COLUMNS, [agent("A", 2), agent("B", 3)]))).toBe(
            "Estimated value is at or above the allocated cost for all 2 agents.",
        );
        expect(agentCoverageHeadline(table(AGENT_COLUMNS, [agent("A", 0.2), agent("B", 0.9)]))).toBe(
            "Estimated value is at or above the allocated cost for none of the 2 agents.",
        );
    });

    it("says nothing for fewer than two agents with a return", () => {
        expect(agentCoverageHeadline(table(AGENT_COLUMNS, []))).toBeUndefined();
        expect(agentCoverageHeadline(table(AGENT_COLUMNS, [agent("A", 2), agent("B", null)]))).toBeUndefined();
    });
});

const SURFACE_COLUMNS = ["Lens", "Category", "All Tasks", "Licensed Tasks", "Unlicensed Tasks", "Agent Tasks"];

describe("surface and model headlines", () => {
    const usage = table(SURFACE_COLUMNS, [
        ["Surface", "Teams", 600, 500, 100, 20],
        ["Surface", "Outlook", 300, 280, 20, 0],
        ["Surface", "Word", 100, 100, 0, 0],
        ["Model", "GPT-4o", 700, 600, 100, 20],
        ["Model", "o3", 300, 280, 20, 0],
    ]);

    it("reads each chart's own lens", () => {
        expect(SURFACE_HEADLINE(usage)).toBe("Teams is the largest, at 60% of tasks.");
        expect(MODEL_HEADLINE(usage)).toBe("GPT-4o is the largest, at 70% of tasks.");
        expect(SURFACE_HEADLINE(usage)).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no rows or a single category", () => {
        expect(SURFACE_HEADLINE(table(SURFACE_COLUMNS, []))).toBeUndefined();
        expect(MODEL_HEADLINE(table(SURFACE_COLUMNS, [["Model", "GPT-4o", 10, 10, 0, 0], ["Surface", "Teams", 5, 5, 0, 0]]))).toBeUndefined();
    });
});

const BREAKDOWN_COLUMNS = ["Dimension", "Category", "Tasks", "Share"];

describe("task breakdown headlines", () => {
    const breakdown = table(BREAKDOWN_COLUMNS, [
        ["Behaviour", "Summarise", 500, 0.5],
        ["Behaviour", "Draft", 300, 0.3],
        ["Behaviour", "Search", 200, 0.2],
        ["Workflow action", "Create", 450, 0.45],
        ["Workflow action", "Review", 550, 0.55],
        ["Value outcome", "Time saved", 1000, 1],
    ]);

    it("follows the lens the toggle picks", () => {
        expect(TASK_BREAKDOWN_HEADLINES.behaviour(breakdown)).toBe("Summarise is the largest, at 50% of tasks.");
        expect(TASK_BREAKDOWN_HEADLINES.action(breakdown)).toBe("Review is the largest, at 55% of tasks.");
        expect(TASK_BREAKDOWN_HEADLINES.action(breakdown)).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for a lens with one category or no rows", () => {
        expect(TASK_BREAKDOWN_HEADLINES.outcome(breakdown)).toBeUndefined();
        expect(TASK_BREAKDOWN_HEADLINES.behaviour(table(BREAKDOWN_COLUMNS, []))).toBeUndefined();
    });
});

describe("time saved headline", () => {
    const columns = [TASK_GROUP_COLUMN, TASK_CATEGORY_COLUMN, "Activity Share", HOURS_PER_WEEK_COLUMN, "AI Assisted Value Per Week"];

    it("names the task with the most expert-equivalent hours", () => {
        const text = TIME_SAVED_HEADLINE(
            table(columns, [
                ["Writing", "Drafting emails", 0.3, 42.5, 2125],
                ["Writing", "Editing documents", 0.2, 18, 900],
                ["Analysis", "Summarising meetings", 0.1, 30, 1500],
            ]),
        );
        expect(text).toBe(`Drafting emails has the most expert-equivalent hours a week, at ${(42.5).toLocaleString()}.`);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing with fewer than two tasks", () => {
        expect(TIME_SAVED_HEADLINE(table(columns, []))).toBeUndefined();
        expect(TIME_SAVED_HEADLINE(table(columns, [["Writing", "Drafting emails", 0.3, 42.5, 2125]]))).toBeUndefined();
    });
});
