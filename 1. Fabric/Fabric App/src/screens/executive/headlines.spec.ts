//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { CREDITS_HEADLINE, HOURS_HEADLINE, withTotal, WORK_KINDS_HEADLINE } from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

const MONTH_COLUMNS = ["Month Start", "Copilot Hours", "Agent Hours", "Cowork Hours", "Hours", "Tasks"];

describe("work delivered by month", () => {
    it("names the busiest month for hours", () => {
        const text = HOURS_HEADLINE(
            table(MONTH_COLUMNS, [
                ["2026-02-01T00:00:00", 300, 40, 0, 340, 900],
                ["2026-03-01T00:00:00", 900.25, 200, 140, 1240.25, 3000],
                ["2026-04-01T00:00:00", 500, 100, 20, 620, 1500],
            ]),
        );
        expect(text).toBe(`Expert-equivalent hours peaked in March 2026, at ${(1240.3).toLocaleString()}.`);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no months or a single month", () => {
        expect(HOURS_HEADLINE(table(MONTH_COLUMNS, []))).toBeUndefined();
        expect(HOURS_HEADLINE(table(MONTH_COLUMNS, [["2026-04-01T00:00:00", 500, 100, 20, 620, 1500]]))).toBeUndefined();
    });
});

const CREDIT_COLUMNS = ["Month Start", "Studio Credits", "Cowork Credits"];

describe("credits consumed by month", () => {
    it("adds Copilot Studio and Cowork before finding the peak", () => {
        const text = CREDITS_HEADLINE(
            table(CREDIT_COLUMNS, [
                ["2026-02-01T00:00:00", 9000, null],
                ["2026-03-01T00:00:00", 6000, 4000],
                ["2026-04-01T00:00:00", null, 2000],
            ]),
        );
        expect(text).toBe(`Credits peaked in March 2026, at ${(10000).toLocaleString()}.`);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no months, one month or nothing consumed", () => {
        expect(CREDITS_HEADLINE(table(CREDIT_COLUMNS, []))).toBeUndefined();
        expect(CREDITS_HEADLINE(table(CREDIT_COLUMNS, [["2026-03-01T00:00:00", 6000, 4000]]))).toBeUndefined();
        expect(
            CREDITS_HEADLINE(
                table(CREDIT_COLUMNS, [
                    ["2026-03-01T00:00:00", 0, null],
                    ["2026-04-01T00:00:00", null, null],
                ]),
            ),
        ).toBeUndefined();
    });

    it("says nothing when none of the parts is there", () => {
        expect(withTotal(["Missing"], "Total", () => "never")(table(CREDIT_COLUMNS, [["2026-03-01T00:00:00", 1, 2]]))).toBeUndefined();
    });
});

const KIND_COLUMNS = ["Chat + Agent Interactions (Audit Logs)Task Breakdown Category", "Hours", "Tasks", "People"];

describe("what the work is", () => {
    it("names the kind of work with the most hours, without a share of a top-six list", () => {
        const text = WORK_KINDS_HEADLINE(
            table(KIND_COLUMNS, [
                ["Drafting", 420, 1200, 80],
                ["Summarising", 300, 900, 60],
                ["Analysis", 120, 200, 15],
            ]),
        );
        expect(text).toBe(`Drafting has the most expert-equivalent hours, at ${(420).toLocaleString()}.`);
        expect(text).not.toMatch(/%/);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no kinds, one kind or a tie", () => {
        expect(WORK_KINDS_HEADLINE(table(KIND_COLUMNS, []))).toBeUndefined();
        expect(WORK_KINDS_HEADLINE(table(KIND_COLUMNS, [["Drafting", 420, 1200, 80]]))).toBeUndefined();
        expect(
            WORK_KINDS_HEADLINE(
                table(KIND_COLUMNS, [
                    ["Drafting", 420, 1200, 80],
                    ["Summarising", 420, 900, 60],
                ]),
            ),
        ).toBeUndefined();
    });
});
