//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    agentTable,
    agentValue,
    AGENT_NAME_COLUMN,
    costValueAgents,
    costValueBySource,
    costValueSpec,
    costValueWindow,
    organizationValue,
    ORGANIZATION_COLUMN,
    pairTable,
    TASK_LABEL_COLUMN,
    toValueTaskTree,
    valueByTask,
    valueSummary,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import { toDataTable } from "@/lib/to-data-table";
import taskRows from "./__fixtures__/value-by-task.rows.json";

const modules = [
    { name: "valueSummary", factory: () => valueSummary(), columns: liveColumns.valueSummary },
    { name: "valueByTask", factory: () => valueByTask(), columns: liveColumns.valueByTask },
    { name: "agentValue", factory: () => agentValue(), columns: liveColumns.agentValue },
    { name: "organizationValue", factory: () => organizationValue(), columns: liveColumns.organizationValue },
    { name: "costValueWindow", factory: () => costValueWindow(), columns: liveColumns.costValueWindow },
    { name: "costValueBySource", factory: () => costValueBySource(), columns: liveColumns.costValueBySource },
    { name: "costValueAgents", factory: () => costValueAgents(), columns: liveColumns.costValueAgents },
];

const specModules = [{ name: "valueByTask", factory: () => valueByTask() }];

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

describe("value query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
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

    it("keeps the what-if parameters outside the base DAX", () => {
        for (const { name, factory } of modules) {
            expect(factory().query).not.toContain("'Hourly Value'[Hourly Value]");
            // The cost comparison reads every scenario at once, to give the return as a range.
            if (name !== "costValueBySource") expect(factory().query).not.toContain("'Effort Scenario'[Scenario]");
        }
    });

    it("reads value by source under every scenario, leaving the rate outside", () => {
        const { query } = costValueBySource();
        expect(query).toMatch(/SUMMARIZECOLUMNS\([\s\S]*'Effort Scenario'\[Scenario\]/);
        expect(query).not.toMatch(/TREATAS|'Effort Scenario'\[Scenario\]\s*=/);
    });
});

describe("value spec field references", () => {
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

describe("cost and value chart field references", () => {
    const tables = [
        { name: "pairs", table: pairTable([]) },
        { name: "agents", table: agentTable([]) },
    ];
    // Columns the chart works out for itself.
    const derived = new Set(["Amount", "Measure", "Amount Label", "Return Label"]);

    it.each(tables)("only references columns the $name table has", ({ table }) => {
        const available = new Set(table.columns.map((column) => column.name));
        for (const field of collectFields(costValueSpec("?"))) {
            if (derived.has(field)) continue;
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it("leaves no unsubstituted placeholders", () => {
        expect(JSON.stringify(costValueSpec("?"))).not.toMatch(/__[A-Z]+__/);
    });
});

describe("value grids", () => {
    it("names the agent column with the cleaned live field name", () => {
        const available = new Set(Object.values(agentValue().columnMetadata).map((def) => def.name));
        expect(available).toContain(AGENT_NAME_COLUMN);
    });

    it("names the organization column with the cleaned live field name", () => {
        const available = new Set(Object.values(organizationValue().columnMetadata).map((def) => def.name));
        expect(available).toContain(ORGANIZATION_COLUMN);
    });

    it("drills from the model's Task Category to its Task Breakdown, not the Work stage category field", () => {
        const { columnMetadata } = valueByTask();
        expect(Object.keys(columnMetadata)).toContain(
            "Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]",
        );
        expect(Object.keys(columnMetadata)).toContain(
            "Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]",
        );
        expect(Object.keys(columnMetadata)).not.toContain("[Category]");
    });

    it("takes category and total rows from the model's rollup", () => {
        expect(valueByTask().query).toContain("ROLLUPADDISSUBTOTAL");
    });

    it("labels the two task levels Task Category and Task Breakdown", () => {
        const { columnMetadata } = valueByTask();
        expect(columnMetadata["Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]"]?.displayName).toBe(
            "Task Category",
        );
        expect(columnMetadata["Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]"]?.displayName).toBe(
            "Task Breakdown",
        );
    });
});

describe("value task tree", () => {
    const { columnMetadata } = valueByTask();
    const table = toDataTable(
        {
            columns: liveColumns.valueByTask.map((name) => ({ name })),
            rows: (taskRows as Record<string, unknown>[]).map((row) => liveColumns.valueByTask.map((name) => row[name])),
        } as never,
        columnMetadata,
    );
    const tree = toValueTaskTree(table);
    const raw = taskRows as Record<string, unknown>[];
    const groupRows = raw.filter((row) => row["[Is Group Total]"] === true && row["[Is Grand Total]"] === false);
    const taskOnly = raw.filter((row) => row["[Is Group Total]"] === false);

    it("returns one row per category with its tasks nested", () => {
        expect(tree.rows).toHaveLength(groupRows.length);
        const nested = tree.rows.flatMap((row) => (row._children as unknown[] | undefined) ?? []);
        expect(nested).toHaveLength(taskOnly.length);
    });

    it("keeps the model's category subtotals instead of summing tasks", () => {
        for (const group of tree.rows) {
            const source = groupRows.find(
                (row) => row["Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]"] === group[TASK_LABEL_COLUMN],
            );
            expect(group["AI Assisted Value Per Week"]).toBe(source?.["[AI Assisted Value Per Week]"]);
        }
    });

    it("lifts the grand total into a one-row totals table", () => {
        const grand = raw.find((row) => row["[Is Grand Total]"] === true);
        expect(tree.total?.rows).toHaveLength(1);
        expect(tree.total?.rows[0][0]).toBe("Total");
        expect(tree.total?.rows[0]).toContain(grand?.["[AI Assisted Value Per Week]"]);
    });

    it("gives every row a unique id so expansion state is stable", () => {
        const ids = tree.rows.flatMap((row) => [row._id, ...((row._children as { _id?: string }[] | undefined) ?? []).map((c) => c._id)]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("exposes only task rows to the time-saved chart", () => {
        expect(tree.tasks.rows).toHaveLength(taskOnly.length);
        expect(tree.tasks.columns.map((column) => column.name)).toContain(
            "Chat + Agent Interactions (Audit Logs)Task Breakdown Category",
        );
    });

    it("labels the time-saved chart's levels Task Category and Task Breakdown", () => {
        const labels = new Map(tree.tasks.columns.map((column) => [column.name, column.displayName]));
        expect(labels.get("Chat + Agent Interactions (Audit Logs)Task Breakdown Group")).toBe("Task Category");
        expect(labels.get("Chat + Agent Interactions (Audit Logs)Task Breakdown Category")).toBe("Task Breakdown");
    });
});
