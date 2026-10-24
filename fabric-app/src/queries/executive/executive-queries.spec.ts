//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { applyDaxFilters, evaluateBody } from "@/lib/dax-filters";
import { tenantDefaultDates } from "@/lib/filters";
import { TREND_MONTHS } from "@/lib/month-over-month";
import { reportingDateFilter } from "@/queries/consumption/options";
import { filterOptions } from "@/queries/filters/filter-options";
import {
    CREDIT_PARTS,
    EXCLUDED_KINDS,
    executiveCreditDates,
    executiveCreditParts,
    executiveCredits,
    executiveDepartments,
    executiveHoursRange,
    executiveMonths,
    executiveRecentMonths,
    executiveSummary,
    executiveWorkKinds,
    FADED_OPACITY,
    monthLabel,
    shapeMonthlyTrend,
    WORK_KINDS_SHOWN,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import creditDateRows from "./__fixtures__/executive-credit-dates.rows.json";
import creditRows from "./__fixtures__/executive-credits.rows.json";
import departmentRows from "./__fixtures__/executive-departments.rows.json";
import rangeRows from "./__fixtures__/executive-hours-range.rows.json";
import monthRows from "./__fixtures__/executive-months.rows.json";
import summaryRows from "./__fixtures__/executive-summary.rows.json";
import workKindRows from "./__fixtures__/executive-work-kinds.rows.json";
import hoursSpec from "./executive-hours.json";

const modules = [
    { name: "executiveSummary", factory: executiveSummary, columns: liveColumns.executiveSummary, rows: summaryRows, connection: "vl" },
    { name: "executiveHoursRange", factory: executiveHoursRange, columns: liveColumns.executiveHoursRange, rows: rangeRows, connection: "vl" },
    { name: "executiveMonths", factory: () => executiveMonths(), columns: liveColumns.executiveMonths, rows: monthRows, connection: "vl" },
    {
        name: "executiveRecentMonths",
        factory: () => executiveRecentMonths(),
        columns: liveColumns.executiveMonths,
        rows: monthRows,
        connection: "vl",
    },
    { name: "executiveDepartments", factory: executiveDepartments, columns: liveColumns.executiveDepartments, rows: departmentRows, connection: "vl" },
    { name: "executiveWorkKinds", factory: executiveWorkKinds, columns: liveColumns.executiveWorkKinds, rows: workKindRows, connection: "vl" },
    { name: "executiveCredits", factory: () => executiveCredits(), columns: liveColumns.executiveCredits, rows: creditRows, connection: "cc" },
    { name: "executiveCreditDates", factory: executiveCreditDates, columns: liveColumns.executiveCreditDates, rows: creditDateRows, connection: "cc" },
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
            } else if (key === "fold" && Array.isArray(value)) {
                value.forEach((item) => typeof item === "string" && found.add(item));
            } else {
                collectFields(value, found);
            }
        }
    }
    return found;
}

/** Names a spec's own transforms introduce, which never come from the query. */
function collectDerivedFields(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach((item) => collectDerivedFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "as") {
                if (typeof value === "string") found.add(value);
                if (Array.isArray(value)) value.forEach((item) => typeof item === "string" && found.add(item));
            } else {
                collectDerivedFields(value, found);
            }
        }
    }
    return found;
}

describe("executive query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name's captured rows carry exactly those columns", ({ rows, columns }) => {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(Object.keys(row).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets its model", ({ factory, connection }) => {
        expect(factory().connection).toBe(connection);
    });

    it.each(modules)("$name ships a non-empty DAX query", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
        expect(raw).toContain("EVALUATE");
    });
});

describe("executive spec field references", () => {
    const specModules = [
        { name: "executiveMonths", factory: () => executiveMonths() },
        { name: "executiveMonths (shaped)", factory: () => executiveMonths({ months: ["May 2026"], rangeMonth: "2026-05-01" }) },
        { name: "executiveCredits", factory: () => executiveCredits() },
        { name: "executiveWorkKinds", factory: () => executiveWorkKinds() },
    ];

    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));
        const derived = collectDerivedFields(vegaLiteSpec);
        for (const field of collectFields(vegaLiteSpec)) {
            if (derived.has(field)) continue;
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it.each(specModules)("$name has no timeUnit and no placeholders", ({ factory }) => {
        const serialized = JSON.stringify(factory().vegaLiteSpec);
        expect(serialized).not.toContain("timeUnit");
        expect(serialized).not.toMatch(/__[A-Z]+__/);
    });

    it("never prints money", () => {
        for (const { factory } of specModules) {
            const spec = { ...(factory().vegaLiteSpec as Record<string, unknown>) };
            delete spec.$schema;
            expect(JSON.stringify(spec)).not.toMatch(/[$£€¥]|Cost|Spend|Price/i);
        }
    });
});

describe("the excluded kinds of work", () => {
    const queries = [executiveSummary(), executiveWorkKinds()];

    it("are left out by every query that counts or ranks kinds of work", () => {
        for (const { query } of queries) {
            for (const kind of EXCLUDED_KINDS) expect(query).toContain(`"${kind}"`);
        }
    });

    it("never appear among the ranked kinds of work", () => {
        const kinds = workKindRows.map((row) => row["Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]"]);
        for (const kind of EXCLUDED_KINDS) expect(kinds).not.toContain(kind);
    });

    it("rank as many kinds of work as the chart promises", () => {
        expect(executiveWorkKinds().query).toContain(`TOPN(${WORK_KINDS_SHOWN},`);
        expect(workKindRows.length).toBeLessThanOrEqual(WORK_KINDS_SHOWN);
    });
});

describe("the per-person breadth measures", () => {
    // A per-person average over every user is the slowest query on a large tenant, so the start-up queries leave it out.
    it.each([
        ["executiveSummary", executiveSummary().query],
        ["executiveMonths", executiveMonths().query],
        ["executiveRecentMonths", executiveRecentMonths().query],
        ["executiveDepartments", executiveDepartments().query],
    ])("are not in %s", (_, query) => {
        expect(query).not.toMatch(/Skills Per Person|Broad Users|Agent With Most Users/);
    });
});

describe("the trend with no date filter", () => {
    const { query } = executiveRecentMonths();
    const squash = (text: string) => text.replace(/\s+/g, " ").trim();

    it("is the trend's own query, limited to the six months to the last day of activity", () => {
        expect(query.match(/\bEVALUATE\b/g)).toHaveLength(1);
        expect(squash(evaluateBody(query))).toContain(
            squash(`CALCULATETABLE(
${evaluateBody(executiveMonths().query)}
,
        FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= _trendFrom && 'Calendar'[Date] <= _trendEnd)
    )`),
        );
        expect(query).toContain(`VAR _trendFrom = EOMONTH(_trendEnd, -${TREND_MONTHS}) + 1`);
        expect(query.trimEnd()).toMatch(/\nORDER BY \[Month Start\]$/);
    });

    it("ends on the last day the filter options give the page, read past every filter", () => {
        const lastDay = "MAX('Chat + Agent Interactions (Audit Logs)'[ActivityDate])";
        expect(filterOptions().query).toContain(`FORMAT(${lastDay}, "yyyy-MM-dd")`);
        expect(query).toContain(`VAR _trendEnd = CALCULATE(${lastDay}, REMOVEFILTERS())`);
        // The tenant's default window ends on the same day, so the trend's months are the same under it.
        expect(tenantDefaultDates()).toContain(`VAR __TenantLastDate = CALCULATE(${lastDay}, REMOVEFILTERS())`);
    });

    it("keeps its months when the page's filters wrap it", () => {
        const filtered = applyDaxFilters(query, ["F"]);
        expect(filtered.match(/\bEVALUATE\b/g)).toHaveLength(1);
        expect(evaluateBody(filtered)).toBe(`CALCULATETABLE(\n${evaluateBody(query)}\n,\n    F\n)`);
    });
});

describe("the credits for the trend and the date range", () => {
    const DATES = { trend: { from: "2026-02-01", to: "2026-07-06" }, range: { from: "2026-05-08", to: "2026-07-06" } };
    const { query, columnMetadata, connection } = executiveCreditParts(DATES);
    const squash = (text: string) => text.replace(/\s+/g, " ").trim();
    /** What the page asked for one part in a query of its own: the credits query, filtered to the part's dates. */
    const alone = (part: (typeof CREDIT_PARTS)[number]) =>
        evaluateBody(applyDaxFilters(executiveCredits().query, [reportingDateFilter(DATES[part].from, DATES[part].to)]));

    it("asks each part as the page asked it alone, in one query", () => {
        expect(query.match(/\bEVALUATE\b/g)).toHaveLength(1);
        expect(squash(evaluateBody(query))).toBe(
            squash(`UNION( ${CREDIT_PARTS.map((part) => `ADDCOLUMNS( ${alone(part)}, "Part", "${part}" )`).join(", ")} )`),
        );
        expect(query.trimEnd()).toMatch(/\nORDER BY \[Part\], \[Month Start\]$/);
    });

    it("reads its rows as the credits query's, from the same model", () => {
        expect(connection).toBe(executiveCredits().connection);
        expect(columnMetadata).toEqual(executiveCredits().columnMetadata);
    });

    it("names each part as the page splits them", () => {
        expect([...query.matchAll(/"Part", "(\w+)"/g)].map((match) => match[1])).toEqual([...CREDIT_PARTS]);
    });
});

describe("the summary's agents in use and people with an organization", () => {
    // Asking about each agent, or each person, in turn was slow on a large tenant, so the summary counts them all at once.
    it("are counted without asking about each agent or person", () => {
        const { query } = executiveSummary();
        expect(query).not.toMatch(/\[Active Agent Users\]\s*>\s*0/);
        expect(query).not.toContain("VALUES('Chat + Agent Interactions (Audit Logs)'[Audit_UserId])");
    });
});

describe("the hours range, asked beside the summary", () => {
    // The Conservative to Optimistic range was a quarter of the summary's time on a large tenant, and
    // every other figure in the summary waited for it, so it's a query of its own.
    const lf = (query: string) => query.replace(/\r\n/g, "\n");
    const summary = lf(executiveSummary().query);
    const range = lf(executiveHoursRange().query);
    /** Each one-line `"Name", <expression>` column a query asks, by name. */
    const columnsOf = (query: string) =>
        new Map([...query.matchAll(/^\s*"([^"]+)", (\S.*?),?$/gm)].map(([, name, expression]) => [name, expression]));

    /** The summary's two range columns as 0.6.8-rc.1 asked them, byte for byte. */
    const RANGE_BEFORE = {
        "Hours Conservative": `CALCULATE([Expert Equivalent Hours], 'Effort Scenario'[Scenario] = "Conservative")`,
        "Hours Optimistic": `CALCULATE([Expert Equivalent Hours], 'Effort Scenario'[Scenario] = "Optimistic")`,
    };

    /**
     * SHA-256 of the summary with the range put back after its hours, as one query, with LF line ends.
     * When the range moved out, this was the summary 0.6.8-rc.1 asked, byte for byte: the move changed
     * no column. Since then, only the summary's comment on [Active Agent Users] has changed.
     */
    const SUMMARY_WITH_RANGE = "79af161d91f8ef8b7de5f3569e9dfbd70d98527ebfbd9a8f1f0f320d26fa9a6e";

    it("asks the two columns the summary asked, byte for byte, and nothing else", () => {
        expect(Object.fromEntries(columnsOf(range))).toEqual(RANGE_BEFORE);
    });

    it("works the range out as the summary works out its hours, at the other two scenarios", () => {
        const hours = columnsOf(summary).get("Hours");
        expect(hours).toContain(`'Effort Scenario'[Scenario] = "Typical"`);
        expect(columnsOf(range).get("Hours Conservative")).toBe(hours?.replace(`"Typical"`, `"Conservative"`));
        expect(columnsOf(range).get("Hours Optimistic")).toBe(hours?.replace(`"Typical"`, `"Optimistic"`));
    });

    it("is no longer asked by the summary", () => {
        expect(summary).not.toMatch(/Conservative|Optimistic/);
    });

    it("puts back together with the summary, byte for byte, as the summary that asked it", async () => {
        const lines = summary.split("\n");
        const at = lines.findIndex((line) => line.trimStart().startsWith(`"Hours", `));
        const indent = lines[at].slice(0, lines[at].length - lines[at].trimStart().length);
        const moved = range
            .split("\n")
            .filter((line) => /^\s*"Hours (Conservative|Optimistic)", /.test(line))
            .map((line) => `${indent}${line.trim().replace(/,?$/, ",")}`);
        const whole = [...lines.slice(0, at + 1), ...moved, ...lines.slice(at + 1)].join("\n");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(whole));
        const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        expect(
            hex,
            "executive-summary.dax or executive-hours-range.dax changed. If you meant it, check the range is still " +
                `worked out as the summary works out its hours, then set SUMMARY_WITH_RANGE to "${hex}".`,
        ).toBe(SUMMARY_WITH_RANGE);
    });

    it("takes the filter bar as the summary does", () => {
        // Neither has a filter profile of its own, so both take the ValueLens model's default.
        // executive-lead-queries.spec.tsx checks the filters each is sent with.
        expect(Object.keys(executiveHoursRange()).sort()).toEqual(Object.keys(executiveSummary()).sort());
        expect(executiveHoursRange().connection).toBe(executiveSummary().connection);
    });
});

describe("shapeMonthlyTrend", () => {
    const transformOf = (spec: unknown) =>
        (spec as { transform: { calculate?: string; as?: string }[] }).transform.find((step) => step.as === "Emphasis");
    const xDomain = (spec: unknown) => (spec as { encoding: { x: { scale: { domain?: string[] } } } }).encoding.x.scale.domain;
    const colorRange = (spec: unknown) =>
        (spec as { layer: { encoding: { color: { scale: { range: string[] } } } }[] }).layer[0].encoding.color.scale.range;

    it("labels months the way the spec prints them", () => {
        expect(monthLabel("2026-05-01")).toBe("May 2026");
        expect(monthLabel("2025-12-01T00:00:00")).toBe("Dec 2025");
    });

    it("fixes the x axis to the months given", () => {
        const months = ["Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026"];
        expect(xDomain(shapeMonthlyTrend(hoursSpec, { months }))).toEqual(months);
        expect(xDomain(shapeMonthlyTrend(hoursSpec))).toBeUndefined();
    });

    it("fades the months before the date range", () => {
        const emphasis = transformOf(shapeMonthlyTrend(hoursSpec, { rangeMonth: "2026-05-01" }));
        expect(emphasis?.calculate).toBe(`datum['Month Start'] < '2026-05-01' ? ${FADED_OPACITY} : 1`);
    });

    it("ignores a range month that is not an ISO date", () => {
        const emphasis = transformOf(shapeMonthlyTrend(hoursSpec, { rangeMonth: "May' ? 0 : 1 //" }));
        expect(emphasis?.calculate).toBe("1");
    });

    it("applies theme colours only when there is one per series", () => {
        const colors = ["#111111", "#222222", "#333333"];
        expect(colorRange(shapeMonthlyTrend(hoursSpec, { colors }))).toEqual(colors);
        expect(colorRange(shapeMonthlyTrend(hoursSpec, { colors: ["#111111"] }))).toEqual(colorRange(hoursSpec));
    });

    it("never mutates the shipped spec", () => {
        const before = JSON.stringify(hoursSpec);
        shapeMonthlyTrend(hoursSpec, { months: ["May 2026"], rangeMonth: "2026-05-01", colors: ["#1", "#2", "#3"] });
        expect(JSON.stringify(hoursSpec)).toBe(before);
    });
});
