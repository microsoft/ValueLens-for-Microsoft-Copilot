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
    agentLeaderboard,
    agentLifecycle,
    agentSurfaces,
    agentUsage,
    coworkCandidates,
    coworkFitSummary,
    coworkReadinessByOrg,
    coworkReadinessSummary,
    describeRegistryLinkage,
    isDepthUniform,
    toAgentEntries,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import estateRows from "./__fixtures__/agent-estate-summary.rows.json";
import leaderboardRows from "./__fixtures__/agent-leaderboard.rows.json";
import candidateRows from "./__fixtures__/cowork-candidates.rows.json";

type Row = Record<string, string | number | boolean | null>;

const modules = [
    { name: "agentActivitySummary", factory: () => agentActivitySummary(), columns: liveColumns.agentActivitySummary },
    { name: "agentUsage", factory: () => agentUsage(), columns: liveColumns.agentUsage },
    { name: "agentEstateSummary", factory: () => agentEstateSummary(), columns: liveColumns.agentEstateSummary },
    { name: "agentLifecycle", factory: () => agentLifecycle(), columns: liveColumns.agentLifecycle },
    { name: "agentLeaderboard", factory: () => agentLeaderboard(), columns: liveColumns.agentLeaderboard },
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

describe("agent leaderboard", () => {
    const { query, columnMetadata } = agentLeaderboard();
    const rows = leaderboardRows as Row[];
    const entries = toAgentEntries(toDataTable(asQueryTable(rows), columnMetadata));

    // The model relates the audit log and the registry both ways, so without
    // a one-way join a date filter would drop every agent nobody used; and
    // clearing the audit table's filters would clear the agent type too.
    it("keeps the registry whole by joining it to the audit log one way", () => {
        expect(query).toMatch(
            /CROSSFILTER\(\s*'Chat \+ Agent Interactions \(Audit Logs\)'\[Agent_LinkID\],\s*'Agents 365'\[Title ID\],\s*OneWay\s*\)/,
        );
        expect(query).not.toMatch(/(REMOVEFILTERS|ALL)\(\s*'Chat \+ Agent Interactions \(Audit Logs\)'\s*\)/);
    });

    it("ranks by users, then sessions", () => {
        expect(query.trim()).toMatch(/ORDER BY \[Users\] DESC, \[Sessions\] DESC, \[Agent\] ASC$/);
    });

    it("leaves out the draft placeholder agent, as the report's Leaderboard page does", () => {
        expect(query).toContain('<> "Draft as 1P Agent"');
    });

    it("gives every row its own key, even agents that share a name", () => {
        const keys = entries.map((entry) => entry.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(entries.filter((entry) => entry.name === "Agent").length).toBeGreaterThan(1);
    });

    it("reads usage and the last active day for an agent the registry lacks", () => {
        expect(entries[0]).toMatchObject({
            name: "Finance Analyst Bot",
            inRegistry: false,
            type: "Not in registry",
            users: 62,
            sessions: 529,
            orgsReached: 6,
            lastActivity: "2026-07-06",
        });
        expect(entries[0].registryId).toBeUndefined();
        expect(entries[0].description).toBeUndefined();
    });

    it("counts an unused registered agent's users, sessions and orgs as zero", () => {
        const unused = entries.find((entry) => entry.inRegistry);
        expect(unused).toMatchObject({ users: 0, sessions: 0, orgsReached: 0 });
        expect(unused?.sessionsPerUser).toBeUndefined();
        expect(unused?.returnRate).toBeUndefined();
        expect(unused?.lastActivity).toBeUndefined();
        expect(unused?.registryId).toMatch(/^[A-Z]_/);
    });

    it("treats a blank description as missing", () => {
        const described = entries.filter((entry) => entry.name === "Agent").map((entry) => entry.description);
        expect(described).toContain("Built using Microsoft Copilot Studio.");
        expect(described).toContain(undefined);
        expect(described).not.toContain("");
    });

    it("reads every features text the registry uses as surfaces, or leaves it as written", () => {
        for (const entry of entries.filter((item) => item.features)) {
            if (entry.surfaces === undefined) {
                expect(entry.features).toBe("Unknown / insufficient capability evidence");
            } else {
                expect(entry.surfaces.length).toBeGreaterThan(0);
            }
        }
    });
});

describe("agent surfaces", () => {
    it.each([
        ["🤖 in Copilot", ["Copilot"]],
        ["💬 in Teams", ["Teams"]],
        ["🤖 in Copilot 💬 in Teams", ["Copilot", "Teams"]],
        ["🤖 in Copilot 💬 in Teams 📧 in Outlook 📄 in Office", ["Copilot", "Teams", "Outlook", "Office"]],
    ])("reads %s", (features, expected) => {
        expect(agentSurfaces(features)).toEqual(expected);
    });

    it("leaves text it can't read to be shown as written", () => {
        expect(agentSurfaces("Unknown / insufficient capability evidence")).toBeUndefined();
        expect(agentSurfaces("🤖 Copilot")).toBeUndefined();
        expect(agentSurfaces("")).toBeUndefined();
        expect(agentSurfaces(null)).toBeUndefined();
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
