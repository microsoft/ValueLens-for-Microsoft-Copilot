//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    habitLicenceMatrix,
    LICENSE_BREADTH_FULL_MARKS,
    licenseCandidates,
    licenseCandidatesM365,
    licenseDemandSummary,
    licenseDormancy,
    licenseEstateSummary,
    licensePriorityByOrg,
    unlicensedHeavyUsers,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import candidateRows from "./__fixtures__/license-candidates.rows.json";

type Row = Record<string, string | number | boolean | null>;

const modules = [
    { name: "licenseDemandSummary", factory: () => licenseDemandSummary(), columns: liveColumns.licenseDemandSummary },
    { name: "licenseEstateSummary", factory: () => licenseEstateSummary(), columns: liveColumns.licenseEstateSummary },
    { name: "licensePriorityByOrg", factory: () => licensePriorityByOrg(), columns: liveColumns.licensePriorityByOrg },
    { name: "licenseCandidates", factory: () => licenseCandidates(), columns: liveColumns.licenseCandidates },
    { name: "licenseCandidatesM365", factory: () => licenseCandidatesM365(), columns: liveColumns.licenseCandidatesM365 },
    { name: "licenseDormancy", factory: () => licenseDormancy(), columns: liveColumns.licenseDormancy },
    { name: "habitLicenceMatrix", factory: () => habitLicenceMatrix(), columns: liveColumns.habitLicenceMatrix },
    { name: "unlicensedHeavyUsers", factory: () => unlicensedHeavyUsers(), columns: liveColumns.unlicensedHeavyUsers },
];

const specModules = [
    { name: "licensePriorityByOrg", factory: () => licensePriorityByOrg() },
    { name: "licenseDormancy", factory: () => licenseDormancy() },
];

/** Characters `ColumnDef.name` strips from the original DAX column name. */
function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

/** Every `field` reference anywhere in a Vega-Lite spec. */
function collectFields(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach((item) => collectFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "field" && typeof value === "string") {
                found.add(value);
            } else {
                collectFields(value, found);
            }
        }
    }
    return found;
}

describe("licensing query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        const { columnMetadata } = factory();
        expect(Object.keys(columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets the bound connection", ({ factory }) => {
        expect(factory().connection).toBe("vl");
    });

    it.each(modules)("$name ships a non-empty DAX query", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
    });

    it("bands habits by the same active days as the Adoption page", () => {
        const { query } = habitLicenceMatrix();
        expect(query).toContain('{ "Power", 1, 16, 31 }');
        expect(query).toContain('{ "Habitual", 2, 11, 15 }');
        expect(query).toContain('{ "Developing", 3, 6, 10 }');
        expect(query).toContain('{ "Beginner", 4, 1, 5 }');
        expect(unlicensedHeavyUsers().query).toContain("[@Days] >= 11");
    });

    it("ranks license candidates at user grain", () => {
        const { query } = licenseCandidates();
        const grouping = query.slice(query.indexOf("SUMMARIZECOLUMNS("), query.indexOf('"@Score"'));
        expect(grouping).toContain("[Audit_UserId]");
        expect(grouping).not.toContain("[Organization]");
        expect(query).toContain("LOOKUPVALUE(");
    });

    it("keeps dormancy ordered by the model bucket order", () => {
        const { query } = licenseDormancy();
        expect(query).toContain("'Copilot Licensed'[Dormancy Bucket Order]");
        expect(query).toContain("[Licensed Seats by Dormancy (Verified)]");
    });
});

describe("license candidates with Microsoft 365 activity", () => {
    const { query, columnMetadata } = licenseCandidatesM365();

    it("returns the model's candidate columns plus workload breadth", () => {
        expect(Object.keys(columnMetadata)).toEqual([...Object.keys(licenseCandidates().columnMetadata), "[Workloads Per Day]"]);
    });

    it("ranks at user grain, like the model's list", () => {
        const grouping = query.slice(query.indexOf("SUMMARIZECOLUMNS("), query.indexOf('"@Tasks"'));
        expect(grouping).toContain("[Audit_UserId]");
        expect(grouping).not.toContain("[Organization]");
        expect(query).toContain("RANKX(_scored, [@Score], , DESC, DENSE)");
        expect(query).toContain("LOOKUPVALUE(");
    });

    it("scores Copilot use with the same measures as the model's score", () => {
        expect(query).toContain("[Median Unlicensed AI Tasks Per User Per Week]");
        expect(query).toContain("[Median Chat + Agent Active Days Per User Per Week (Unlicensed)]");
        expect(query).toContain("MIN(DIVIDE([@Tasks], 30, 0), 1)");
        expect(query).toContain("MIN(DIVIDE([@Days], 5, 0), 1)");
    });

    it("keeps candidates the model's list would show", () => {
        expect(query).toContain("[@Tasks] > 0 && [@Days] > 0 && [@Observed] > 0");
        expect(query).toContain("[Observed Unlicensed Sessions]");
    });

    it("reads breadth from the same person's Microsoft 365 active days", () => {
        expect(query).toContain(
            "TREATAS({ 'Chat + Agent Interactions (Audit Logs)'[Audit_UserId] }, 'M365 Activity'[UPN_Normalized])",
        );
        expect(query).toContain("AVERAGE('M365 Activity'[WorkloadsActive])");
        expect(query).toContain("'M365 Activity'[WorkloadsActive] > 0");
        expect(query).toContain(`MIN(DIVIDE([@Breadth], ${LICENSE_BREADTH_FULL_MARKS}, 0), 1)`);
    });

    it("weighs both scores out of 100, falling back to the model's weights without Microsoft 365 activity", () => {
        const blended = query.match(/(\d+) \* _volume \+ (\d+) \* _days \+ (\d+) \* MIN/);
        const fallback = query.match(/ISBLANK\(\[@Breadth\]\),\s*(\d+) \* _volume \+ (\d+) \* _days,/);
        expect(blended?.slice(1).map(Number)).toEqual([50, 30, 20]);
        expect(fallback?.slice(1).map(Number)).toEqual([60, 40]);
    });
});

describe("licensing spec field references", () => {
    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));
        for (const field of collectFields(vegaLiteSpec)) {
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it.each(specModules)("$name leaves no unsubstituted placeholders", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/__[A-Z]+__/);
    });

    it.each(specModules)("$name never relies on timeUnit to parse dates", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/"timeUnit"/);
    });
});

describe("license candidates", () => {
    it("arrives ranked, best candidate first", () => {
        const ranks = (candidateRows as Row[]).map((row) => row["[Rank]"] as number);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(ranks[0]).toBe(1);
    });
});
