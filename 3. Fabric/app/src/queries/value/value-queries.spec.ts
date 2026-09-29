//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    agentValue,
    AGENT_NAME_COLUMN,
    organizationValue,
    ORGANIZATION_COLUMN,
    valueByTaskGroup,
    valueSummary,
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "valueSummary", factory: () => valueSummary(), columns: liveColumns.valueSummary },
    { name: "valueByTaskGroup", factory: () => valueByTaskGroup(), columns: liveColumns.valueByTaskGroup },
    { name: "agentValue", factory: () => agentValue(), columns: liveColumns.agentValue },
    { name: "organizationValue", factory: () => organizationValue(), columns: liveColumns.organizationValue },
];

const specModules = [{ name: "valueByTaskGroup", factory: () => valueByTaskGroup() }];

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
        for (const { factory } of modules) {
            expect(factory().query).not.toContain("'Hourly Value'[Hourly Value]");
            expect(factory().query).not.toContain("'Effort Scenario'[Scenario]");
        }
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

describe("value grids", () => {
    it("names the agent column with the cleaned live field name", () => {
        const available = new Set(Object.values(agentValue().columnMetadata).map((def) => def.name));
        expect(available).toContain(AGENT_NAME_COLUMN);
    });

    it("names the organization column with the cleaned live field name", () => {
        const available = new Set(Object.values(organizationValue().columnMetadata).map((def) => def.name));
        expect(available).toContain(ORGANIZATION_COLUMN);
    });

    it("charts the model's grouped task field, not the Work stage category field", () => {
        const { columnMetadata } = valueByTaskGroup();
        expect(Object.keys(columnMetadata)).toContain(
            "Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]",
        );
        expect(Object.keys(columnMetadata)).not.toContain("[Category]");
    });
});
