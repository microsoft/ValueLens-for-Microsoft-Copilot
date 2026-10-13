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
    APP_REACH_HEADLINE,
    copilotGapHeadline,
    PLATFORM_REACH_HEADLINE,
    SUITE_DEPTH_HEADLINE,
    WORKLOAD_REACH_HEADLINE,
    WORKLOAD_TREND_HEADLINE,
} from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

describe("widest-reach headlines", () => {
    const reach = table(
        ["Workload", "People", "Reach", "Days Per Week"],
        [
            ["Teams", 97, 0.97, 4.2],
            ["Email", 90, 0.9, 4.8],
            ["Viva Engage", 12, 0.12, 1.1],
        ],
    );

    it("names the workload that reaches the most people", () => {
        const text = WORKLOAD_REACH_HEADLINE(reach);
        expect(text).toBe("Teams reaches the most people, at 97% of those active.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("reads apps and platforms the same way", () => {
        expect(APP_REACH_HEADLINE(table(["App", "People", "Reach"], [["Outlook", 92, 0.92], ["Word", 70, 0.7]]))).toBe(
            "Outlook reaches the most people, at 92% of those active.",
        );
        expect(
            PLATFORM_REACH_HEADLINE(
                table(["Platform", "People", "Reach", "Days Per Week"], [["Windows", 80, 0.8, 4], ["Mobile", 55, 0.55, 3]]),
            ),
        ).toBe("Windows reaches the most people, at 80% of those active.");
    });

    it("says nothing for no rows, one row, too few people or a tie", () => {
        const columns = ["Workload", "People", "Reach", "Days Per Week"];
        expect(WORKLOAD_REACH_HEADLINE(table(columns, []))).toBeUndefined();
        expect(WORKLOAD_REACH_HEADLINE(table(columns, [["Teams", 97, 0.97, 4]]))).toBeUndefined();
        expect(WORKLOAD_REACH_HEADLINE(table(columns, [["Teams", 3, 0.75, 4], ["Email", 2, 0.5, 4]]))).toBeUndefined();
        expect(WORKLOAD_REACH_HEADLINE(table(columns, [["Teams", 90, 0.9, 4], ["Email", 90, 0.9, 4]]))).toBeUndefined();
    });
});

describe("WORKLOAD_TREND_HEADLINE", () => {
    const columns = ["Week Start", "Workload", "People", "Share"];

    it("reads the latest week on the chart", () => {
        const trend = table(columns, [
            ["2026-05-04T00:00:00", "Teams", 80, 0.8],
            ["2026-05-04T00:00:00", "Email", 90, 0.9],
            ["2026-05-11T00:00:00", "Teams", 94, 0.94],
            ["2026-05-11T00:00:00", "Email", 88, 0.88],
        ]);
        const text = WORKLOAD_TREND_HEADLINE(trend);
        expect(text).toBe("In the week of 11 May 2026, Teams reached the most people, at 94% of those active.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no weeks, one workload or too few people in the latest week", () => {
        expect(WORKLOAD_TREND_HEADLINE(table(columns, []))).toBeUndefined();
        expect(WORKLOAD_TREND_HEADLINE(table(columns, [["2026-05-11T00:00:00", "Teams", 94, 0.94]]))).toBeUndefined();
        expect(
            WORKLOAD_TREND_HEADLINE(
                table(columns, [
                    ["2026-05-04T00:00:00", "Teams", 80, 0.8],
                    ["2026-05-04T00:00:00", "Email", 90, 0.9],
                    ["2026-05-11T00:00:00", "Teams", 2, 0.5],
                    ["2026-05-11T00:00:00", "Email", 1, 0.25],
                ]),
            ),
        ).toBeUndefined();
    });
});

describe("SUITE_DEPTH_HEADLINE", () => {
    const columns = ["Apps Used", "Apps", "People", "Share"];
    const depth = (people: number[]) =>
        table(
            columns,
            people.map((count, apps) => [apps === 6 ? "All 6 apps" : `${apps} apps`, apps, count, 0]),
        );

    it("describes how many apps half or more of the active people opened", () => {
        const text = SUITE_DEPTH_HEADLINE(depth([5, 5, 10, 26, 30, 14, 10]));
        expect(text).toBe("54% of active people opened 4 or more of the six apps.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says all six or at least one at the ends", () => {
        expect(SUITE_DEPTH_HEADLINE(depth([0, 0, 0, 0, 10, 20, 70]))).toBe("70% of active people opened all six apps.");
        expect(SUITE_DEPTH_HEADLINE(depth([60, 30, 10, 0, 0, 0, 0]))).toBe(
            "40% of active people opened at least one of the six apps.",
        );
    });

    it("says nothing for no rows, everyone in one bucket or too few people", () => {
        expect(SUITE_DEPTH_HEADLINE(table(columns, []))).toBeUndefined();
        expect(SUITE_DEPTH_HEADLINE(depth([0, 0, 0, 0, 0, 0, 40]))).toBeUndefined();
        expect(SUITE_DEPTH_HEADLINE(depth([1, 0, 0, 2, 0, 0, 1]))).toBeUndefined();
    });
});

describe("copilotGapHeadline", () => {
    const columns = ["Metric", "Copilot Users", "Others", "Index"];
    const index = table(columns, [
        ["Chat messages", 34, 20, 1.7],
        ["Meetings", 6, 5, 1.2],
        ["Active days", 4.6, 4.2, 1.1],
        ["Emails sent", 9, 10, 0.9],
    ]);

    it("names the widest gap as a comparison, not a cause", () => {
        const text = copilotGapHeadline(120, 400)(index);
        expect(text).toBe(
            "Chat messages show the widest gap: Copilot users average 1.7× as many as everyone else. A comparison, not a cause.",
        );
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("counts a gap below 1× as wide as one above it", () => {
        const fewer = table(columns, [
            ["Meetings", 6, 5, 1.2],
            ["Emails sent", 4, 10, 0.4],
        ]);
        expect(copilotGapHeadline(120, 400)(fewer)).toBe(
            "Emails sent show the widest gap: Copilot users average 0.4× as many as everyone else. A comparison, not a cause.",
        );
    });

    it("says nothing for a small group, one metric, no real gap or a tie", () => {
        expect(copilotGapHeadline(4, 400)(index)).toBeUndefined();
        expect(copilotGapHeadline(120, 3)(index)).toBeUndefined();
        expect(copilotGapHeadline(undefined, 400)(index)).toBeUndefined();
        expect(copilotGapHeadline(120, 400)(table(columns, []))).toBeUndefined();
        expect(copilotGapHeadline(120, 400)(table(columns, [["Meetings", 6, 3, 2]]))).toBeUndefined();
        expect(
            copilotGapHeadline(120, 400)(table(columns, [["Meetings", 5, 5, 1.02], ["Emails sent", 5, 5, 0.99]])),
        ).toBeUndefined();
        expect(copilotGapHeadline(120, 400)(table(columns, [["Meetings", 4, 2, 2], ["Emails sent", 2, 4, 0.5]]))).toBeUndefined();
    });
});
