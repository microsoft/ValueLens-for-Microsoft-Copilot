//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The Adoption summary is asked as two queries, where rc.1 asked one. Each
 * column of its ROW is a figure of its own, worked out in the filter context
 * around the ROW and nowhere else, so the two parts answer exactly as the one
 * query did provided they hold the same columns, with the same expressions,
 * under the same filters and task times. These tests hold them to that.
 */

import { describe, expect, it } from "vitest";
import { applyDaxFilters, dateBetween, treatAs } from "@/lib/dax-filters";
import { FILTER_COLUMNS } from "@/lib/filters";
import { HOURS_MEASURES } from "../assumptions/hours-measures";
import { readsTaskTimes, withTaskTimes, type TaskTimeOverride } from "../assumptions/task-times";
import { adoptionSummary } from "./adoption-summary";
import { adoptionSummarySpuw } from "./adoption-summary-spuw";
import {
    columns,
    frame,
    isSpuw,
    lf,
    WHOLE_ADOPTION_SUMMARY as WHOLE,
    withoutSpuw,
} from "./adoption-summary-whole.fixture";

const core = lf(adoptionSummary().query);
const spuw = lf(adoptionSummarySpuw().query);

const EMAIL: TaskTimeOverride = { task: "Email Drafting", low: 6, typical: 16, high: 24 };
const CHAT: TaskTimeOverride = { task: "General Chat", low: 1, typical: 2, high: 3 };
const SAVED_TIMES: readonly (readonly TaskTimeOverride[])[] = [[EMAIL], [EMAIL, CHAT]];

const FILTER_SETS: readonly (readonly string[])[] = [
    [dateBetween(FILTER_COLUMNS.date, "2026-01-01", "2026-03-31")],
    [
        dateBetween(FILTER_COLUMNS.date, "2026-01-01", "2026-03-31"),
        treatAs(FILTER_COLUMNS.agentType, ["Declarative"]),
        treatAs(FILTER_COLUMNS.agentName, ["Helper", "Writer"]),
    ],
];

/** The measure each column reads. */
const measureOf = (column: string) => /\[([^\]]+)\]$/.exec(column)?.[1];

describe("the Adoption summary's two parts", () => {
    it("hold the whole query's fifteen columns between them, each once and each byte for byte", () => {
        const whole = columns(WHOLE);
        expect(whole).toHaveLength(15);
        expect(new Set(whole).size).toBe(15);

        expect(columns(core)).toEqual(whole.filter((column) => !isSpuw(column)));
        expect(columns(spuw)).toEqual(whole.filter(isSpuw));
        expect(columns(core)).toHaveLength(10);
        expect(columns(spuw)).toHaveLength(5);
        expect([...columns(core), ...columns(spuw)].sort()).toEqual([...whole].sort());
    });

    it("are the whole query with the columns shared out, and nothing else changed", () => {
        expect(core).toBe(withoutSpuw(WHOLE));
        const rates = columns(WHOLE).filter(isSpuw);
        const lines = rates.map((column, index) => `    ${column}${index < rates.length - 1 ? "," : ""}`);
        expect(spuw).toBe(["EVALUATE", "ROW(", ...lines, ")", ""].join("\n"));
        expect(frame(core)).toEqual(frame(WHOLE));
        expect(frame(spuw)).toEqual(frame(WHOLE));
        expect(frame(WHOLE)).toEqual(["EVALUATE", "ROW(", ")", ""]);
    });

    it("work each figure out on its own, with no definition or variable a column could share", () => {
        for (const part of [core, spuw]) {
            expect(part.match(/\bEVALUATE\b/g)).toHaveLength(1);
            expect(part.match(/\bROW\(/g)).toHaveLength(1);
            expect(part).not.toMatch(/\b(DEFINE|MEASURE|VAR|RETURN)\b/);
            expect(part).not.toMatch(/\/\/|--|\/\*/);
        }
    });

    it("go under the same filters as the whole query, wrapped the same way", () => {
        for (const filters of FILTER_SETS) {
            const filteredWhole = applyDaxFilters(WHOLE, filters);
            expect(filteredWhole).toContain("CALCULATETABLE(");

            expect(lf(applyDaxFilters(adoptionSummary().query, filters))).toBe(withoutSpuw(filteredWhole));
            const filteredSpuw = lf(applyDaxFilters(adoptionSummarySpuw().query, filters));
            expect(frame(filteredSpuw)).toEqual(frame(filteredWhole));
            expect(columns(filteredSpuw)).toEqual(columns(spuw));
            for (const filter of filters) expect(filteredSpuw).toContain(`    ${filter}`);
        }
    });

    it("go unwrapped, as the whole query does, when no filter applies", () => {
        expect(applyDaxFilters(WHOLE, [])).toBe(WHOLE);
        expect(applyDaxFilters(core, [])).toBe(core);
        expect(applyDaxFilters(spuw, [])).toBe(spuw);
    });

    it("are worked out at the same task times as the whole query", () => {
        expect(readsTaskTimes(WHOLE)).toBe(true);
        expect(readsTaskTimes(core)).toBe(true);
        expect(readsTaskTimes(spuw)).toBe(false);

        for (const saved of SAVED_TIMES) {
            const timedWhole = withTaskTimes(WHOLE, saved);
            expect(timedWhole).toMatch(/^DEFINE\n/);
            expect(timedWhole).toContain('"Email Drafting", SWITCH(');
            expect(lf(withTaskTimes(adoptionSummary().query, saved))).toBe(withoutSpuw(timedWhole));
            expect(withTaskTimes(adoptionSummarySpuw().query, saved)).toBe(adoptionSummarySpuw().query);

            for (const filters of FILTER_SETS) {
                const sentWhole = applyDaxFilters(timedWhole, filters);
                const sentCore = applyDaxFilters(withTaskTimes(adoptionSummary().query, saved), filters);
                const sentSpuw = applyDaxFilters(withTaskTimes(adoptionSummarySpuw().query, saved), filters);
                expect(lf(sentCore)).toBe(withoutSpuw(sentWhole));
                expect(sentSpuw).toBe(applyDaxFilters(adoptionSummarySpuw().query, filters));
            }
        }
    });

    it("leave every figure the task times change in the part that waits for them", () => {
        const hours = new Set(HOURS_MEASURES.map((measure) => measure.name));
        const spuwMeasures = columns(spuw).map(measureOf);
        expect(spuwMeasures).toHaveLength(5);
        expect(spuwMeasures.filter((name) => name && hours.has(name))).toEqual([]);
        expect(columns(core).map(measureOf).filter((name) => name && hours.has(name))).toEqual([
            "Expert Equivalent Hours Per Week",
            "Top Value Outcome",
            "Cowork Expert Equivalent Hours Per Week",
            "Cowork Top Value Outcome",
        ]);
    });
});
