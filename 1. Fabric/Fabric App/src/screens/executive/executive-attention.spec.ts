//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { QueryTable } from "@microsoft/fabric-app-data";
import type { SummaryRow } from "@/lib/summary-row";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import { feedbackCategory } from "@/queries/feedback";
import { executiveDepartments, DEPARTMENT_COLUMN } from "@/queries/executive";
import { licenseDormancy } from "@/queries/licensing";
import coworkRows from "@/queries/consumption/__fixtures__/cowork-credits-summary.rows.json";
import departmentRows from "@/queries/executive/__fixtures__/executive-departments.rows.json";
import summaryRows from "@/queries/executive/__fixtures__/executive-summary.rows.json";
import themeRows from "@/queries/feedback/__fixtures__/feedback-category.rows.json";
import dormancyRows from "@/queries/licensing/__fixtures__/license-dormancy.rows.json";
import estateRows from "@/queries/licensing/__fixtures__/license-estate-summary.rows.json";
import { attentionItems, lowerQuartile, type AttentionInputs, type AttentionItem } from "./executive-attention";
import { tableRecords } from "./executive-data";

type Row = Record<string, string | number | boolean | null>;

/** The rows a fixture holds, as the screen reads them once the SDK and `toDataTable` have had them. */
function records(rows: readonly Row[], columnMetadata: ColumnMetadataMap): SummaryRow[] {
    const names = Object.keys(rows[0]);
    const table = {
        columns: names.map((name) => ({ name, dataType: "string" })),
        rows: rows.map((row) => names.map((name) => row[name])),
    } as QueryTable;
    return tableRecords(toDataTable(table, columnMetadata));
}

const departments = records(departmentRows, executiveDepartments().columnMetadata);

/** The demo tenant, as the four queries the rules read answer for it. */
const demo: AttentionInputs = {
    summary: summaryRows[0] as SummaryRow,
    dormancy: records(dormancyRows, licenseDormancy().columnMetadata),
    estate: estateRows[0] as SummaryRow,
    departments,
    cowork: coworkRows[0] as SummaryRow,
    themes: records(themeRows, feedbackCategory().columnMetadata),
    orgPlural: "organizations",
};

function item(items: AttentionItem[], rule: AttentionItem["rule"]): AttentionItem | undefined {
    return items.find((candidate) => candidate.rule === rule);
}

describe("attentionItems on the demo tenant", () => {
    const items = attentionItems(demo);

    it("raises all four rules, the most seats, people or ratings first", () => {
        expect(items.map((entry) => [entry.rule, entry.reach])).toEqual([
            ["weakest-theme", 69],
            ["idle-seats", 49],
            ["enablement-gap", 32],
            ["cowork-over-allowance", 24],
        ]);
    });

    it("counts idle seats from the dormancy buckets, largest first", () => {
        expect(item(items, "idle-seats")).toEqual({
            rule: "idle-seats",
            tone: "caution",
            title: "Reassign 49 idle seats",
            evidence:
                "Licensed seats with no Copilot activity in 30 days or more: 45 never active and 4 inactive 30-89 days. 30 people already use Copilot without a license.",
            reach: 49,
            stake: "22% of seats",
            link: { destination: "readiness", stage: "license-readiness", label: "Open Readiness" },
        });
    });

    it("turns Cowork's over-limit share into people", () => {
        expect(item(items, "cowork-over-allowance")).toMatchObject({
            tone: "negative",
            title: "24 people are over their Cowork allowance",
            evidence:
                "16% of the 150 people using Cowork in the current billing period went past their spending policy's credit limit, across 3 spending policies.",
            stake: "16% of Cowork users",
            link: { destination: "consumption", stage: "cowork-credits" },
        });
    });

    it("names the organizations in the bottom quarter for both hours per seat and kinds of work", () => {
        const gap = item(items, "enablement-gap");
        expect(gap?.title).toBe("Focus enablement on HR");
        expect(gap?.stake).toBe("+37 hours a quarter");
        expect(gap?.evidence).toContain("bottom quarter of organizations");
        expect(gap?.evidence).toContain("average of 3.5 hours per seat a month");
        expect(gap?.link).toEqual({ destination: "adoption", label: "Open Adoption" });
    });

    it("finds the least liked theme with enough ratings to count", () => {
        expect(item(items, "weakest-theme")).toMatchObject({
            title: "Teams & Remote Work is the least liked theme",
            evidence: "52% thumbs up across 69 ratings, against 62% across all feedback.",
            stake: "10 pp below overall",
        });
    });

    it("gives the same list whatever order the rows arrive in", () => {
        const shuffled: AttentionInputs = {
            ...demo,
            dormancy: [...(demo.dormancy ?? [])].reverse(),
            departments: [...departments].reverse(),
            themes: [...(demo.themes ?? [])].reverse(),
        };
        expect(attentionItems(shuffled)).toEqual(items);
    });

    it("never prints money", () => {
        for (const entry of items) {
            expect(`${entry.title} ${entry.evidence} ${entry.stake}`).not.toMatch(/[£$€¥]|\bcost\b|\bspend\b/i);
        }
    });
});

describe("attentionItems thresholds", () => {
    it("raises nothing from nothing", () => {
        expect(attentionItems({ orgPlural: "organizations" })).toEqual([]);
    });

    it("leaves idle seats out while the license inventory doesn't reconcile", () => {
        const items = attentionItems({ ...demo, estate: { "[License Inventory Usable]": 0 } });
        expect(item(items, "idle-seats")).toBeUndefined();
    });

    it("leaves idle seats out below 5% of the estate", () => {
        const dormancy = [
            { "Dormancy Bucket Order": 1, "Dormancy Bucket": "Active (<30 days)", "Licensed Users": 96 },
            { "Dormancy Bucket Order": 5, "Dormancy Bucket": "Never active", "Licensed Users": 4 },
        ];
        expect(item(attentionItems({ ...demo, dormancy }), "idle-seats")).toBeUndefined();
        dormancy[1]["Licensed Users"] = 6;
        expect(item(attentionItems({ ...demo, dormancy }), "idle-seats")?.title).toBe("Reassign 6 idle seats");
    });

    it("leaves Cowork out when nobody is over their limit", () => {
        const cowork = { ...demo.cowork, "[Users Over Limit]": 0 };
        expect(item(attentionItems({ ...demo, cowork }), "cowork-over-allowance")).toBeUndefined();
    });

    it("needs four organizations to speak of a bottom quarter", () => {
        const items = attentionItems({ ...demo, departments: departments.slice(0, 3) });
        expect(item(items, "enablement-gap")).toBeUndefined();
    });

    it("ignores rows without a name or seats", () => {
        const unnamed = departments.map((row) => ({ ...row, [DEPARTMENT_COLUMN]: null }));
        expect(item(attentionItems({ ...demo, departments: unnamed }), "enablement-gap")).toBeUndefined();
    });

    it("needs 20 ratings before a theme counts", () => {
        const themes = (demo.themes ?? []).map((row) =>
            row.Category === "Teams & Remote Work" ? { ...row, "Total Feedback": 19 } : row,
        );
        expect(item(attentionItems({ ...demo, themes }), "weakest-theme")?.title).not.toContain("Teams & Remote Work");
    });
});

describe("lowerQuartile", () => {
    it("takes the nearest rank a quarter of the way up", () => {
        expect(lowerQuartile([])).toBeUndefined();
        expect(lowerQuartile([5])).toBe(5);
        expect(lowerQuartile([4, 1, 3, 2])).toBe(1);
        expect(lowerQuartile([9, 1, 5, 3, 7])).toBe(3);
    });
});