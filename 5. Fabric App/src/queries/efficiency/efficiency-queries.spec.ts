//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { isGroupRow } from "@/lib/rollup-tree";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import {
    coworkFitByTask,
    coworkFitPeople,
    coworkWorkShape,
    deriveModelFitVerdict,
    modelFitByOrganization,
    modelFitByPerson,
    modelFitByTask,
    modelFitSummary,
    modelMatchByTool,
    modelUsage,
    PEOPLE_LABEL_COLUMN,
    toPeopleTree,
    toWorkShapeTree,
    withGradeNames,
    WORK_LABEL_COLUMN,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import byTaskRows from "./__fixtures__/cowork-fit-by-task.rows.json";
import peopleRows from "./__fixtures__/cowork-fit-people.rows.json";
import shapeRows from "./__fixtures__/cowork-work-shape.rows.json";

const modules = [
    { name: "modelFitSummary", factory: () => modelFitSummary(), columns: liveColumns.modelFitSummary },
    { name: "modelUsage", factory: () => modelUsage(), columns: liveColumns.modelUsage },
    { name: "modelMatchByTool", factory: () => modelMatchByTool(), columns: liveColumns.modelMatchByTool },
    { name: "modelFitByTask", factory: () => modelFitByTask(), columns: liveColumns.modelFitByTask },
    { name: "modelFitByOrganization", factory: () => modelFitByOrganization(), columns: liveColumns.modelFitByOrganization },
    { name: "modelFitByPerson", factory: () => modelFitByPerson(), columns: liveColumns.modelFitByPerson },
    { name: "coworkFitByTask", factory: () => coworkFitByTask(), columns: liveColumns.coworkFitByTask },
    { name: "coworkWorkShape", factory: () => coworkWorkShape(), columns: liveColumns.coworkWorkShape },
    { name: "coworkFitPeople", factory: () => coworkFitPeople(), columns: liveColumns.coworkFitPeople },
];

const specModules = [
    { name: "modelUsage", factory: () => modelUsage() },
    { name: "modelMatchByTool", factory: () => modelMatchByTool() },
    { name: "coworkFitByTask", factory: () => coworkFitByTask() },
];

type FixtureRow = Record<string, unknown>;

/** A fixture as the query layer would receive it: live column order, raw DAX names. */
function fixtureTable(rows: FixtureRow[], columns: readonly string[], columnMetadata: ColumnMetadataMap) {
    return toDataTable(
        { columns: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => row[name])) } as never,
        columnMetadata,
    );
}

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

describe("efficiency query contract", () => {
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

    it("queries each verdict grouping directly instead of relying on the field parameter", () => {
        expect(modelFitByTask().query).toContain("[Task Breakdown Group]");
        expect(modelFitByOrganization().query).toContain("[Organization]");
        expect(modelFitByPerson().query).toContain("[Audit_UserId]");
        expect(modelFitByTask().query).not.toContain("'Model Fit View'");
    });

    it("reads only Cowork sessions and leaves ungraded ones out of the shares", () => {
        expect(coworkFitByTask().query).toContain("[Usage Efficiency: Task Grade Share]");
        expect(coworkWorkShape().query).toMatch(/ROLLUPADDISSUBTOTAL/);
        // The live model has no Who Flag measure, so the query defines the report's rule itself.
        expect(coworkFitPeople().query).toMatch(/^DEFINE\b/);
        expect(coworkFitPeople().query).toContain("[Usage Efficiency: Who Low Share] >= 0.5");
    });

    it("groups the people table by whichever org column is chosen", () => {
        const byOffice = coworkFitPeople({
            column: "officeLocation",
            label: "Office location",
            noun: "office location",
            plural: "office locations",
        });
        expect(byOffice.query).toContain("'Chat + Agent Org Data'[officeLocation]");
        expect(byOffice.query).not.toContain("'Chat + Agent Org Data'[Organization]");
        expect(byOffice.columnMetadata["Chat + Agent Org Data[officeLocation]"]).toBeDefined();
    });
});

describe("cowork fit by task", () => {
    const { columnMetadata } = coworkFitByTask();
    const table = withGradeNames(fixtureTable(byTaskRows, liveColumns.coworkFitByTask, columnMetadata));
    const grade = table.columns.findIndex((column) => column.name === "Grade");

    it("keeps the current grade names", () => {
        expect(new Set(table.rows.map((row) => row[grade]))).toEqual(new Set(["Strong fit", "Fair fit", "Worth a look"]));
    });

    it("renames grades from models built before the rename", () => {
        const old = withGradeNames({
            columns: [{ name: "Grade" }, { name: "Grade Order" }],
            rows: [
                ["High fit", 0],
                ["Medium fit", 1],
                ["Low fit", 2],
                ["Something new", 1],
            ],
        });
        expect(old.rows.map((row) => row[0])).toEqual(["Strong fit", "Fair fit", "Worth a look", "Fair fit"]);
    });
});

describe("cowork work shape tree", () => {
    const { columnMetadata } = coworkWorkShape();
    const tree = toWorkShapeTree(fixtureTable(shapeRows, liveColumns.coworkWorkShape, columnMetadata));

    it("lists the grades in the model's order, each holding its shapes of work", () => {
        expect(tree.rows.map((row) => row[WORK_LABEL_COLUMN])).toEqual([
            "Strong fit",
            "Fair fit",
            "Worth a look",
            "Too light to grade",
        ]);
        expect(tree.rows.every(isGroupRow)).toBe(true);
        const strong = tree.rows[0]._children ?? [];
        expect(strong.map((row) => row[WORK_LABEL_COLUMN])).toEqual([
            "Cross-app chain",
            "Builds an artifact",
            "Multi-source synthesis",
        ]);
    });

    it("keeps the model's subtotals, which do not add up for medians", () => {
        const strong = tree.rows[0];
        expect(strong.Sessions).toBe(488);
        expect(strong["Source Items"]).toBe(6);
        expect(tree.total?.Sessions).toBe(1284);
        expect(tree.total?.["Share Of Work"]).toBe(1);
    });

    it("lets the same shape of work sit under two grades", () => {
        const single = tree.rows
            .flatMap((row) => row._children ?? [])
            .filter((row) => row[WORK_LABEL_COLUMN] === "Single-app task");
        expect(single.map((row) => row._id)).toEqual(["leaf:Fair fit/Single-app task", "leaf:Worth a look/Single-app task"]);
    });
});

describe("cowork people tree", () => {
    const { columnMetadata } = coworkFitPeople();
    const table = fixtureTable(peopleRows, liveColumns.coworkFitPeople, columnMetadata);
    const tree = toPeopleTree(table, "Unassigned organization");

    it("nests each person under their group", () => {
        expect(tree.rows.map((row) => row[PEOPLE_LABEL_COLUMN])).toEqual([
            "Finance",
            "Legal",
            "Marketing",
            "Operations",
            "Sales",
        ]);
        const people = tree.rows.flatMap((row) => row._children ?? []);
        expect(people).toHaveLength(16);
        expect(people.every((row) => !isGroupRow(row))).toBe(true);
    });

    it("counts flagged people on each group and in the total", () => {
        const flagged = tree.rows.reduce((sum, row) => sum + ((row["Flagged People"] as number | null) ?? 0), 0);
        expect(tree.total?.["Flagged People"]).toBe(flagged);
        for (const group of tree.rows) {
            const members = (group._children ?? []).filter((row) => row["Flagged People"] === 1).length;
            expect((group["Flagged People"] as number | null) ?? 0).toBe(members);
        }
    });

    it("names a blank group", () => {
        const blank = toPeopleTree(
            {
                ...table,
                rows: [[null, "someone@contoso-demo.com", false, false, null, 9, 0.2, 0.3, 0.5, 1]],
            },
            "Unassigned organization",
        );
        expect(blank.rows[0][PEOPLE_LABEL_COLUMN]).toBe("Unassigned organization");
    });
});

describe("efficiency spec field references", () => {
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

describe("model fit verdicts", () => {
    it("returns not judged below five judged sessions", () => {
        expect(deriveModelFitVerdict({ judgedSessions: 4, overSpecifiedSessions: 4, underSpecifiedSessions: 0 })).toBe(
            "Not judged",
        );
    });

    it("treats blank over and under counts as a good match", () => {
        expect(
            deriveModelFitVerdict({
                judgedSessions: 12,
                overSpecifiedSessions: null,
                underSpecifiedSessions: undefined,
            }),
        ).toBe("Good match");
    });

    it("uses the largest exception bucket when the segment is not a good match", () => {
        expect(deriveModelFitVerdict({ judgedSessions: 12, overSpecifiedSessions: 7, underSpecifiedSessions: 1 })).toBe(
            "Lighter model may do",
        );
        expect(deriveModelFitVerdict({ judgedSessions: 12, overSpecifiedSessions: 2, underSpecifiedSessions: 6 })).toBe(
            "Try stronger",
        );
    });
});
