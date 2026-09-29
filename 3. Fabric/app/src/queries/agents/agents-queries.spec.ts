//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { QueryTable } from "@microsoft/fabric-app-data";
import { toDataTable } from "@/lib/to-data-table";
import { toSummaryRow } from "@/lib/summary-row";
import {
    agentActivitySummary,
    agentEstateSummary,
    agentLifecycle,
    agentRegistry,
    agentUsage,
    coworkCandidates,
    coworkFitSummary,
    coworkReadinessByOrg,
    coworkReadinessSummary,
    describeRegistryLinkage,
    isDepthUniform,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import estateRows from "./__fixtures__/agent-estate-summary.rows.json";
import candidateRows from "./__fixtures__/cowork-candidates.rows.json";

type Row = Record<string, string | number | boolean | null>;

const modules = [
    { name: "agentActivitySummary", factory: () => agentActivitySummary(), columns: liveColumns.agentActivitySummary },
    { name: "agentUsage", factory: () => agentUsage(), columns: liveColumns.agentUsage },
    { name: "agentEstateSummary", factory: () => agentEstateSummary(), columns: liveColumns.agentEstateSummary },
    { name: "agentLifecycle", factory: () => agentLifecycle(), columns: liveColumns.agentLifecycle },
    { name: "agentRegistry", factory: () => agentRegistry(), columns: liveColumns.agentRegistry },
    {
        name: "coworkReadinessSummary",
        factory: () => coworkReadinessSummary(),
        columns: liveColumns.coworkReadinessSummary,
    },
    { name: "coworkReadinessByOrg", factory: () => coworkReadinessByOrg(), columns: liveColumns.coworkReadinessByOrg },
    { name: "coworkCandidates", factory: () => coworkCandidates(), columns: liveColumns.coworkCandidates },
    { name: "coworkFitSummary", factory: () => coworkFitSummary(), columns: liveColumns.coworkFitSummary },
];

const specModules = [
    { name: "agentUsage", factory: () => agentUsage() },
    { name: "agentLifecycle", factory: () => agentLifecycle() },
    { name: "coworkReadinessByOrg", factory: () => coworkReadinessByOrg() },
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

/** Rebuilds the positional `QueryTable` the SDK hands the app. */
function asQueryTable(rows: Row[]): QueryTable {
    const names = Object.keys(rows[0]);
    return {
        columns: names.map((name) => ({ name, dataType: "string" })),
        rows: rows.map((row) => names.map((name) => row[name])),
    } as QueryTable;
}

describe("agents query contract", () => {
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

    // The model's own count includes the blank agent name every unmatched
    // session falls under, so it reports one agent in use when none are.
    it("never reads the agent-in-use count that counts the blank name", () => {
        expect(agentEstateSummary().query).not.toContain("[Agents With Observed Activity]");
    });

    // Grouping by organization turns the dynamic rank into a per-organization
    // rank; the organization has to be looked up per person instead.
    it("ranks Cowork candidates organization-wide", () => {
        const { query } = coworkCandidates();
        const grouping = query.slice(query.indexOf("SUMMARIZECOLUMNS("), query.indexOf('"@Rank"'));
        expect(grouping).toContain("[Audit_UserId]");
        expect(grouping).not.toContain("[Organization]");
        expect(query).toContain("LOOKUPVALUE(");
    });
});

describe("agents spec field references", () => {
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

describe("registry linkage", () => {
    it("reports no linkage for the live tenant, where no session matches the registry", () => {
        const row = toSummaryRow(asQueryTable(estateRows as Row[]));
        expect(describeRegistryLinkage(row)).toEqual({
            kind: "none",
            unmatchedSessions: 4500,
            registryAgents: 469,
        });
    });

    it("reports partial linkage when some sessions match and some do not", () => {
        const row = { "[Registry Agents]": 469, "[Seen In Use]": 12, "[Unmatched Sessions]": 300 };
        expect(describeRegistryLinkage(row)).toEqual({
            kind: "partial",
            unmatchedSessions: 300,
            seenInUse: 12,
            registryAgents: 469,
        });
    });

    it("reports complete linkage when every session matches", () => {
        const row = { "[Registry Agents]": 469, "[Seen In Use]": 12, "[Unmatched Sessions]": null };
        expect(describeRegistryLinkage(row)).toEqual({ kind: "complete", seenInUse: 12, registryAgents: 469 });
    });

    it("stays unknown when there is no audit activity to match", () => {
        expect(describeRegistryLinkage({ "[Registry Agents]": 469 })).toEqual({ kind: "unknown" });
        expect(describeRegistryLinkage(undefined)).toEqual({ kind: "unknown" });
    });
});

describe("cowork candidates", () => {
    const { columnMetadata } = coworkCandidates();

    it("detects the live tenant's single-prompt sessions as uniform depth", () => {
        const table = toDataTable(asQueryTable(candidateRows as Row[]), columnMetadata);
        expect(isDepthUniform(table)).toBe(true);
    });

    it("does not call depth uniform once candidates differ", () => {
        const rows = (candidateRows as Row[]).map((row, index) =>
            index === 0 ? { ...row, "[Prompts Per Session]": 2.5 } : row,
        );
        expect(isDepthUniform(toDataTable(asQueryTable(rows), columnMetadata))).toBe(false);
    });

    it("arrives ranked, best candidate first", () => {
        const ranks = (candidateRows as Row[]).map((row) => row["[Rank]"] as number);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(ranks[0]).toBe(1);
    });
});
