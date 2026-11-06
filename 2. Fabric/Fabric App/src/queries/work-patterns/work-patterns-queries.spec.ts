//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { describeOrgAttribute, withOrgAttribute } from "@/lib/org-attribute";
import {
    CONCEALED_THRESHOLD,
    m365Apps,
    m365ByOrg,
    m365CopilotIndex,
    m365CopilotSummary,
    m365Platforms,
    m365Status,
    m365SuiteDepth,
    m365Summary,
    m365WorkloadReach,
    m365WorkloadTrend,
    readM365Coverage,
    readM365Status,
    SMALL_GROUP_MIN_PEOPLE,
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "m365Status", factory: m365Status, columns: liveColumns.m365Status },
    { name: "m365Summary", factory: m365Summary, columns: liveColumns.m365Summary },
    { name: "m365WorkloadTrend", factory: m365WorkloadTrend, columns: liveColumns.m365WorkloadTrend },
    { name: "m365WorkloadReach", factory: m365WorkloadReach, columns: liveColumns.m365WorkloadReach },
    { name: "m365Apps", factory: m365Apps, columns: liveColumns.m365Apps },
    { name: "m365SuiteDepth", factory: m365SuiteDepth, columns: liveColumns.m365SuiteDepth },
    { name: "m365Platforms", factory: m365Platforms, columns: liveColumns.m365Platforms },
    { name: "m365CopilotSummary", factory: m365CopilotSummary, columns: liveColumns.m365CopilotSummary },
    { name: "m365CopilotIndex", factory: m365CopilotIndex, columns: liveColumns.m365CopilotIndex },
    { name: "m365ByOrg", factory: m365ByOrg, columns: liveColumns.m365ByOrg },
];

const specModules = [
    { name: "m365WorkloadTrend", factory: m365WorkloadTrend },
    { name: "m365WorkloadReach", factory: m365WorkloadReach },
    { name: "m365Apps", factory: m365Apps },
    { name: "m365SuiteDepth", factory: m365SuiteDepth },
    { name: "m365Platforms", factory: m365Platforms },
    { name: "m365CopilotIndex", factory: m365CopilotIndex },
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

/** Every column a spec's own transforms add, such as a `toDate` result. */
function derivedFields(spec: unknown): string[] {
    const transforms = (spec as { transform?: { as?: unknown }[] }).transform ?? [];
    return transforms.flatMap((step) => (typeof step.as === "string" ? [step.as] : []));
}

describe("work patterns query contract", () => {
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

    it.each(modules)("$name reads the M365 Activity table", ({ factory }) => {
        expect(factory().query).toContain("'M365 Activity'");
    });

    it("plots only complete Monday-to-Sunday weeks", () => {
        expect(m365WorkloadTrend().query).toContain("[@Days] = 7");
    });

    it.each([
        { name: "m365Summary", factory: m365Summary },
        { name: "m365WorkloadTrend", factory: m365WorkloadTrend },
        { name: "m365WorkloadReach", factory: m365WorkloadReach },
        { name: "m365Platforms", factory: m365Platforms },
        { name: "m365CopilotIndex", factory: m365CopilotIndex },
        { name: "m365ByOrg", factory: m365ByOrg },
    ])("$name counts days across everyone, so an org filter doesn't drop its people's days off", ({ factory }) => {
        const query = factory().query;
        expect(query).toContain(
            "CALCULATE(DISTINCTCOUNT('M365 Activity'[ActivityDate]), REMOVEFILTERS('Chat + Agent Org Data'))",
        );
        expect(query).not.toMatch(/(?<!CALCULATE\()DISTINCTCOUNT\('M365 Activity'\[ActivityDate\]\)/);
    });

    it("dates the coverage note across everyone, matching the days it counts", () => {
        const query = m365Summary().query;
        expect(query).toContain("CALCULATE(MIN('M365 Activity'[ActivityDate]), REMOVEFILTERS('Chat + Agent Org Data'))");
        expect(query).toContain("CALCULATE(MAX('M365 Activity'[ActivityDate]), REMOVEFILTERS('Chat + Agent Org Data'))");
    });

    it("counts Copilot use from the audit log and licenses the way the report does", () => {
        const query = m365CopilotSummary().query;
        expect(query).toContain("'Chat + Agent Interactions (Audit Logs)'[Audit_UserId]");
        expect(query).toContain('UPPER(TRIM(\'Copilot Licensed\'[Has license])) IN { "YES", "TRUE", "Y", "1" }');
    });

    it("compares the same metrics for both groups", () => {
        const query = m365CopilotIndex().query;
        expect(query).toContain("TREATAS(_using, 'M365 Activity'[UPN_Normalized])");
        expect(query).toContain("TREATAS(_rest, 'M365 Activity'[UPN_Normalized])");
    });

    it("rebinds the organization breakdown to the chosen org column", () => {
        const rebound = withOrgAttribute(m365ByOrg(), describeOrgAttribute("Department"));
        expect(rebound.query).toContain("'Chat + Agent Org Data'[Department]");
        expect(rebound.query).not.toContain("'Chat + Agent Org Data'[Organization]");
        expect(rebound.query).toContain("REMOVEFILTERS('Chat + Agent Org Data')");
        expect(rebound.columnMetadata["[Organization]"].displayName).toBe("Department");
    });

    it("pools organizations too small to show on their own into one row", () => {
        const query = m365ByOrg().query;
        expect(query).toContain(`VAR _minPeople = ${SMALL_GROUP_MIN_PEOPLE}`);
        expect(query).toContain("[@People] < _minPeople");
        expect(query).toContain("[@People] >= _minPeople");
        expect(query).toContain('"Pooled Groups"');
    });

    it("returns every suite depth, from no app use reported to all six apps", () => {
        const query = m365SuiteDepth().query;
        for (const app of ["AppOutlook", "AppTeams", "AppWord", "AppExcel", "AppPowerPoint", "AppOneNote"]) {
            expect(query).toContain(`MAX('M365 Activity'[${app}])`);
        }
        expect(query).toContain('{ 0, "No app use reported" }');
        expect(query).toContain('{ 6, "All 6 apps" }');
    });

    it("measures every platform the apps report flags", () => {
        const query = m365Platforms().query;
        for (const platform of ["Windows", "Mac", "Web", "Mobile"]) {
            expect(query).toContain(`'M365 Activity'[Platform${platform}] = 1`);
        }
    });
});

describe("work patterns spec field references", () => {
    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set([
            ...Object.values(columnMetadata).map((def) => def.name),
            ...derivedFields(vegaLiteSpec),
        ]);

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

describe("readM365Status", () => {
    const row = (values: Record<string, unknown>) => values as never;

    it("is loading until the probe answers", () => {
        expect(readM365Status({ loaded: false }).state).toBe("loading");
    });

    it.each([
        "Query (1, 23) Cannot find table 'M365 Activity'.",
        "Failed to resolve name 'M365 Activity'. It is not a valid table, variable, or function name.",
    ])("reads a missing table as an install that predates the module: %s", (error) => {
        expect(readM365Status({ loaded: true, error })).toEqual({ state: "missing", concealed: false });
    });

    it("passes any other failure through", () => {
        const status = readM365Status({ loaded: true, error: "The connection timed out." });
        expect(status).toEqual({ state: "error", concealed: false, error: "The connection timed out." });
    });

    it.each([undefined, 0])("reads %s rows as empty: switched off or not loaded yet", (rows) => {
        expect(readM365Status({ loaded: true, row: row({ "[Rows]": rows }) }).state).toBe("empty");
    });

    it("reads a loaded table as ready, with its window", () => {
        const status = readM365Status({
            loaded: true,
            row: row({
                "[Rows]": 4120,
                "[People]": 208,
                "[First Date]": "2026-07-01",
                "[Last Date]": "2026-09-28",
                "[Concealed Share]": 0,
            }),
        });
        expect(status).toEqual({
            state: "ready",
            people: 208,
            firstDate: "2026-07-01",
            lastDate: "2026-09-28",
            concealed: false,
        });
    });

    it("flags concealed names only past the threshold", () => {
        const at = (share: number) =>
            readM365Status({ loaded: true, row: row({ "[Rows]": 10, "[Concealed Share]": share }) }).concealed;
        expect(at(CONCEALED_THRESHOLD)).toBe(false);
        expect(at(0.98)).toBe(true);
    });
});

describe("readM365Coverage", () => {
    const summary = (values: Record<string, unknown>) => ({
        "[First Date]": "2026-07-01",
        "[Last Date]": "2026-07-31",
        "[Days Loaded]": 27,
        ...values,
    });

    it("counts the days in the span with nothing loaded", () => {
        expect(readM365Coverage(summary({}))).toEqual({
            firstDate: "2026-07-01",
            lastDate: "2026-07-31",
            spanDays: 31,
            daysLoaded: 27,
            missingDays: 4,
        });
    });

    it("counts both ends of the span, so one day is a span of one", () => {
        const coverage = readM365Coverage(summary({ "[Last Date]": "2026-07-01", "[Days Loaded]": 1 }));
        expect(coverage).toMatchObject({ spanDays: 1, missingDays: 0 });
    });

    it("crosses a clock change without losing a day", () => {
        const coverage = readM365Coverage(summary({ "[First Date]": "2026-10-20", "[Last Date]": "2026-11-02", "[Days Loaded]": 14 }));
        expect(coverage).toMatchObject({ spanDays: 14, missingDays: 0 });
    });

    it.each([
        ["no summary", undefined],
        ["no first date", summary({ "[First Date]": "" })],
        ["no days loaded", summary({ "[Days Loaded]": null })],
        ["a date it can't read", summary({ "[Last Date]": "31/07/2026" })],
        ["dates the wrong way round", summary({ "[First Date]": "2026-08-01" })],
    ])("reads %s as no coverage", (_case, row) => {
        expect(readM365Coverage(row)).toBeUndefined();
    });
});
