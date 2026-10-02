//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { describe, expect, it } from "vitest";
import { HOURS_MEASURES } from "./hours-measures";
import {
    HOURS_PER_MINUTE,
    MINUTES_MAX,
    modelTaskTimes,
    parseMinutes,
    readHoursPerMinute,
    readModelTaskTimes,
    readsTaskTimes,
    sameTaskTime,
    taskHoursPerMinute,
    taskTimeKey,
    validateTaskTime,
    withTaskTimes,
    type TaskTimeOverride,
} from "./task-times";
import taskRows from "./__fixtures__/task-times.rows.json";
import hourRows from "./__fixtures__/hours-per-minute.rows.json";

const ROOT = "Human Equivalent Hours (Behaviour Basis)";
const EMAIL: TaskTimeOverride = { task: "Email Drafting", low: 6, typical: 16, high: 24 };

const queries = import.meta.glob<string>("../**/*.dax", { query: "?raw", import: "default", eager: true });

function toTable(rows: readonly Record<string, unknown>[]): QueryTable {
    const names = Object.keys(rows[0] ?? {});
    return {
        columns: names.map((name) => ({ name })),
        rows: rows.map((row) => names.map((name) => row[name])),
    } as unknown as QueryTable;
}

function defines(query: string, measure: string): boolean {
    return new RegExp(`MEASURE '[^']+'\\[${measure.replace(/[()]/g, "\\$&")}\\] =`).test(query);
}

describe("withTaskTimes", () => {
    const value = "EVALUATE ROW(\"Value\", [AI Assisted Value])";

    it("leaves a query alone when no time is saved", () => {
        expect(withTaskTimes(value, [])).toBe(value);
    });

    it("leaves a query alone when it shows no hours", () => {
        const users = "EVALUATE ROW(\"Users\", [Active Users])";
        expect(withTaskTimes(users, [EMAIL])).toBe(users);
    });

    it("redefines the minutes measure and every measure between it and the query", () => {
        const query = withTaskTimes(value, [EMAIL]);
        for (const measure of [ROOT, "Expert Equivalent Hours", "AI Assisted Value"]) {
            expect(defines(query, measure), measure).toBe(true);
        }
        expect(defines(query, "Net ROI")).toBe(false);
        expect(query).toContain('"Email Drafting", SWITCH(_scn, "Conservative", 6, "Optimistic", 24, 16)');
        expect(query).toContain("VAR _task = 'Behavior Value Map'[Behavior]");
    });

    it("falls back to the model's minutes for every other task", () => {
        const query = withTaskTimes(value, [EMAIL]);
        expect(query).toMatch(/VAR _model =[\s\S]*'Human Time Estimates'\[Min Typical\][\s\S]*_model\s*\)/);
    });

    it("defines each measure before the measures that read it", () => {
        const query = withTaskTimes("EVALUATE ROW(\"ROI\", [Net ROI])", [EMAIL]);
        const order = HOURS_MEASURES.map((measure) => query.indexOf(`[${measure.name}] =`)).filter((at) => at >= 0);
        expect(order.length).toBeGreaterThan(2);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("doubles quotes in a task's name", () => {
        const query = withTaskTimes(value, [{ ...EMAIL, task: 'Say "hello"' }]);
        expect(query).toContain('"Say ""hello""", SWITCH(');
    });

    it("keeps measures the query defines itself", () => {
        const own = 'DEFINE\n    MEASURE \'Chat + Agent Interactions (Audit Logs)\'[AI Assisted Value] = 1\nEVALUATE ROW("Value", [AI Assisted Value])';
        expect(withTaskTimes(own, [EMAIL])).toBe(own);
    });

    it("ignores times it can't use", () => {
        const broken = [
            { ...EMAIL, typical: Number.NaN },
            { ...EMAIL, task: "" },
            { ...EMAIL, low: -1 },
        ];
        expect(withTaskTimes(value, broken)).toBe(value);
    });

    it("writes the same query whatever order the times come in", () => {
        const chat = { task: "General Chat", low: 1, typical: 2, high: 3 };
        expect(withTaskTimes(value, [EMAIL, chat])).toBe(withTaskTimes(value, [chat, EMAIL]));
    });

    it.each(Object.entries(queries).filter(([, text]) => readsTaskTimes(text)))(
        "applies the times to %s",
        (_path, text) => {
            const query = withTaskTimes(text, [EMAIL]);
            expect(defines(query, ROOT)).toBe(true);
            expect(query).toContain('"Email Drafting", SWITCH(');
        },
    );

    it("finds the queries that show hours or value", () => {
        const reading = Object.keys(queries).filter((path) => readsTaskTimes(queries[path]));
        expect(reading).toEqual(
            expect.arrayContaining([
                "../value/value-summary.dax",
                "../value/value-by-task.dax",
                "../value/cost-vs-value-by-source.dax",
                "../adoption/adoption-summary.dax",
            ]),
        );
        expect(reading).not.toContain("../assumptions/task-times.dax");
    });
});

describe("taskHoursPerMinute", () => {
    const { connection, query } = taskHoursPerMinute();

    it("times every task at one minute, Cowork aside, by task", () => {
        expect(connection).toBe("vl");
        expect(query).toMatch(/VAR _min =\s*1\s*\n\s*VAR _mult/);
        expect(query).toContain("'Behavior Value Map'[Behavior]");
        expect(query).toContain(`[Agent Filter (Normalized)] <> "Cowork"`);
        expect(query).toContain(`"${HOURS_PER_MINUTE}"`);
    });

    it("is not itself moved by saved times", () => {
        expect(readsTaskTimes(query)).toBe(false);
    });
});

describe("readModelTaskTimes", () => {
    const tasks = readModelTaskTimes(toTable(taskRows));

    it("reads every task the model times", () => {
        expect(modelTaskTimes().connection).toBe("vl");
        expect(tasks).toHaveLength(taskRows.length);
        expect(tasks.find((task) => task.task === "Email Drafting")?.research).toEqual({ low: 3, typical: 8, high: 12 });
    });

    it("keeps an empty link as no link", () => {
        expect(tasks.find((task) => task.task === "Build & Deploy Run")?.sourceUrl).toBeUndefined();
    });

    it("can save every researched time as it stands", () => {
        for (const task of tasks) expect(validateTaskTime(task.research), task.task).toBeUndefined();
    });
});

describe("readHoursPerMinute", () => {
    const byTask = readHoursPerMinute(toTable(hourRows));

    it("keys each task's hours per minute by name, leaving out unmapped activity", () => {
        expect(byTask.get(taskTimeKey("Email Drafting"))).toBeCloseTo(14.6333, 3);
        expect(byTask.size).toBe(hourRows.filter((row) => row["Behavior Value Map[Behavior]"]).length);
    });

    it("gives a task's hours as its minutes times that rate", () => {
        // The live model gives Email Drafting 117.07 hours at its Typical 8 minutes.
        expect((byTask.get("email drafting") ?? 0) * 8).toBeCloseTo(117.07, 2);
    });
});

describe("parseMinutes", () => {
    it.each([
        ["", undefined],
        ["  ", undefined],
        ["8", 8],
        ["8.25", 8.3],
        [".5", 0.5],
        ["12 min", 12],
        ["3 minutes", 3],
        ["abc", Number.NaN],
        ["-2", Number.NaN],
        ["1,5", Number.NaN],
    ])("reads %j as %s", (text, expected) => {
        expect(parseMinutes(text)).toEqual(expected);
    });
});

describe("validateTaskTime", () => {
    it("accepts times in order", () => {
        expect(validateTaskTime({ low: 1, typical: 2, high: 3 })).toBeUndefined();
        expect(validateTaskTime({ low: 0, typical: 0, high: 0 })).toBeUndefined();
    });

    it("needs all three", () => {
        expect(validateTaskTime({ low: 1, typical: 2 })).toMatch(/all three/);
    });

    it("needs numbers within a working day", () => {
        expect(validateTaskTime({ low: Number.NaN, typical: 2, high: 3 })).toMatch(/number/);
        expect(validateTaskTime({ low: 1, typical: 2, high: MINUTES_MAX + 1 })).toMatch(/between 0 and 480/);
    });

    it("keeps Conservative at or below Typical at or below Optimistic", () => {
        expect(validateTaskTime({ low: 5, typical: 2, high: 9 })).toMatch(/Conservative/);
        expect(validateTaskTime({ low: 1, typical: 9, high: 5 })).toMatch(/Optimistic/);
    });
});

describe("sameTaskTime", () => {
    it("compares to a tenth of a minute", () => {
        expect(sameTaskTime({ low: 1, typical: 2, high: 3 }, { low: 1.01, typical: 2, high: 3 })).toBe(true);
        expect(sameTaskTime({ low: 1, typical: 2, high: 3 }, { low: 1.1, typical: 2, high: 3 })).toBe(false);
    });
});
