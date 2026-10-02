//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { ModelTaskTime } from "@/queries/assumptions";
import type { SavedTaskTime } from "@/services/task-times.service";
import {
    buildRows,
    filterRows,
    formatMinutes,
    grainLabel,
    lastChange,
    pendingChanges,
    sortRows,
    toDraft,
    typicalHours,
} from "./task-time-rows";

function task(name: string, category: string, typical: number): ModelTaskTime {
    return { task: name, category, grain: "Per Turn", research: { low: typical / 2, typical, high: typical * 2 } };
}

const EMAIL = task("Email Drafting", "Writing", 8);
const CHAT = task("General Chat", "Q&A", 2);
const IDLE = task("Email Triage", "Writing", 4);
const TASKS = [IDLE, CHAT, EMAIL];
const RATES = new Map([
    ["email drafting", 10],
    ["general chat", 50],
]);

describe("buildRows", () => {
    it("starts every task at the research", () => {
        const rows = buildRows(TASKS, [], {}, RATES);
        for (const row of rows) {
            expect(row.current).toEqual(row.research);
            expect(row.shown).toEqual(row.research);
            expect(row.pending || row.custom).toBe(false);
        }
        expect(rows.find((row) => row.task === "Email Triage")?.hoursPerMinute).toBeUndefined();
    });

    it("lays saved times over the research, matching names as DAX does", () => {
        const saved: SavedTaskTime[] = [{ task: "email drafting", low: 5, typical: 10, high: 15 }];
        const row = buildRows(TASKS, saved, {}, RATES).find((each) => each.task === "Email Drafting");
        expect(row?.current).toEqual({ low: 5, typical: 10, high: 15 });
        expect(row?.custom).toBe(true);
        expect(row?.pending).toBe(false);
    });

    it("shows usable typed times and flags them as not saved", () => {
        const rows = buildRows(TASKS, [], { "email drafting": { low: "4", typical: "12", high: "20" } }, RATES);
        const row = rows.find((each) => each.task === "Email Drafting");
        expect(row?.shown).toEqual({ low: 4, typical: 12, high: 20 });
        expect(row?.pending).toBe(true);
        expect(row?.error).toBeUndefined();
    });

    it("keeps the times in use while what is typed can't be used", () => {
        const rows = buildRows(TASKS, [], { "email drafting": { low: "9", typical: "8", high: "16" } }, RATES);
        const row = rows.find((each) => each.task === "Email Drafting");
        expect(row?.error).toMatch(/Conservative/);
        expect(row?.shown).toEqual(EMAIL.research);
        expect(row?.pending).toBe(true);
    });

    it("doesn't count typing the same times back as a change", () => {
        const rows = buildRows(TASKS, [], { "email drafting": toDraft(EMAIL.research) }, RATES);
        expect(rows.some((row) => row.pending)).toBe(false);
    });
});

describe("pendingChanges", () => {
    const saved: SavedTaskTime[] = [{ task: "General Chat", low: 2, typical: 4, high: 8 }];

    it("saves new times, and removes a task's own times when they go back to the research", () => {
        const rows = buildRows(
            TASKS,
            saved,
            {
                "email drafting": { low: "4", typical: "12", high: "20" },
                "general chat": toDraft(CHAT.research),
            },
            RATES,
        );
        expect(pendingChanges(rows)).toEqual(
            expect.arrayContaining([
                { task: "Email Drafting", time: { low: 4, typical: 12, high: 20 } },
                { task: "General Chat", time: null },
            ]),
        );
    });

    it("leaves out times that can't be used", () => {
        const rows = buildRows(TASKS, [], { "email drafting": { low: "", typical: "8", high: "16" } }, RATES);
        expect(pendingChanges(rows)).toEqual([]);
    });
});

describe("typicalHours", () => {
    it("adds up hours per minute times Typical minutes, with the research and as shown", () => {
        const rows = buildRows(TASKS, [], { "email drafting": { low: "4", typical: "12", high: "20" } }, RATES);
        expect(typicalHours(rows)).toEqual({ research: 10 * 8 + 50 * 2, shown: 10 * 12 + 50 * 2 });
    });

    it("has nothing to add up without activity", () => {
        expect(typicalHours(buildRows(TASKS, [], {}, undefined))).toEqual({});
    });
});

describe("sortRows", () => {
    it("puts the most hours first and tasks with no activity last", () => {
        const order = sortRows(buildRows(TASKS, [], {}, RATES)).map((row) => row.task);
        expect(order).toEqual(["General Chat", "Email Drafting", "Email Triage"]);
    });

    it("holds rows still while times are typed", () => {
        const typed = buildRows(TASKS, [], { "email drafting": { low: "100", typical: "200", high: "300" } }, RATES);
        expect(sortRows(typed).map((row) => row.task)[0]).toBe("General Chat");
    });
});

describe("filterRows", () => {
    const rows = buildRows(TASKS, [{ task: "General Chat", low: 2, typical: 4, high: 8 }], {}, RATES);

    it("narrows by category, search and own times", () => {
        expect(filterRows(rows, { category: "Writing" }).map((row) => row.task)).toEqual(["Email Triage", "Email Drafting"]);
        expect(filterRows(rows, { search: " drafting" }).map((row) => row.task)).toEqual(["Email Drafting"]);
        expect(filterRows(rows, { search: "q&a" }).map((row) => row.task)).toEqual(["General Chat"]);
        expect(filterRows(rows, { customOnly: true }).map((row) => row.task)).toEqual(["General Chat"]);
    });
});

describe("helpers", () => {
    it("writes minutes to a tenth without trailing zeros", () => {
        expect(formatMinutes(8)).toBe("8");
        expect(formatMinutes(2.25)).toBe("2.3");
    });

    it("names what a task is counted per", () => {
        expect(grainLabel("Per Turn")).toBe("per prompt");
        expect(grainLabel("Per Resource")).toBe("per file or page read");
    });

    it("finds the latest change", () => {
        const older = { task: "A", low: 1, typical: 2, high: 3, updatedAt: new Date("2026-01-01") };
        const newer = { task: "B", low: 1, typical: 2, high: 3, updatedAt: new Date("2026-02-01") };
        expect(lastChange([older, newer, { task: "C", low: 1, typical: 2, high: 3 }])).toBe(newer);
        expect(lastChange([])).toBeUndefined();
    });
});
