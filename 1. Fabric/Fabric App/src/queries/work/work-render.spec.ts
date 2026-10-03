//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// @vitest-environment node
// Vega builds the full scenegraph without a DOM, and jsdom's stub canvas only
// adds noise (its getContext throws during text measurement).

import { describe, expect, it } from "vitest";
import { compile } from "vega-lite";
import { parse, View, type Scene, type SceneItem } from "vega";
import type { TopLevelSpec } from "vega-lite";
import type { QueryTable } from "@microsoft/fabric-app-data";
import type { Row as GridRow } from "@microsoft/fabric-datagrid";
import { isGroupRow } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { toDataTable } from "@/lib/to-data-table";
import { surfaceUsage, type UsageLens } from "./surface-usage";
import { taskBreakdown, taskDimensions, type TaskDimension } from "./task-breakdown";
import { LEADERBOARD_LABEL_COLUMN, leaderboardPeople, toLeaderboardPeopleTree } from "./leaderboard-people";
import { leaderboardTasks, toLeaderboardTaskTree } from "./leaderboard-tasks";
import { workCohorts, cohortTaskField } from "./cohorts";
import taskBreakdownRows from "./__fixtures__/task-breakdown.rows.json";
import surfaceUsageRows from "./__fixtures__/surface-usage.rows.json";
import leaderboardPeopleRows from "./__fixtures__/leaderboard-people.rows.json";
import leaderboardTaskRows from "./__fixtures__/leaderboard-tasks.rows.json";

type Row = Record<string, string | number | boolean | null>;

/**
 * Renders a spec the way the app does and returns its bar geometry.
 *
 * `VegaVisual` hands Vega records whose keys are the cleaned `ColumnDef.name`
 * values, not the raw DAX column names, so the fixture rows are renamed the
 * same way before they reach the view. Rendering with `renderer: "none"` still
 * builds the full scenegraph, so every mark's resolved position and size is
 * available without a DOM.
 */
async function renderBars(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap) {
    const rename = new Map(
        Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]),
    );
    const values = rows.map((row) =>
        Object.fromEntries(
            Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value]),
        ),
    );

    // "container" sizing resolves against the DOM, which a headless view has none of.
    const sized = { ...(spec as object), width: 600, height: 400, data: { values } } as TopLevelSpec;
    const view = new View(parse(compile(sized).spec), { renderer: "none" });
    await view.runAsync();

    const bars: SceneItem[] = [];
    const walk = (node: Scene | SceneItem) => {
        const scene = node as Scene;
        if (scene.marktype === "rect") bars.push(...(scene.items as SceneItem[]));
        for (const item of (scene.items ?? []) as (Scene | SceneItem)[]) {
            if ((item as Scene).marktype || (item as { items?: unknown }).items) walk(item);
        }
    };
    walk((view.scenegraph() as unknown as { root: Scene }).root);
    await view.finalize();
    return bars;
}

/**
 * Bars must have real geometry — the failure mode a screenshot glance misses.
 *
 * A band scale nests each bar in its own group, so the rect's own `y` is
 * relative and undefined at the top level. `bounds` is the resolved absolute
 * rectangle, which is what actually has to be non-empty for anything to appear.
 */
function expectDrawableBars(bars: SceneItem[], expectedCount: number) {
    expect(bars).toHaveLength(expectedCount);
    for (const bar of bars) {
        const { bounds, width, height } = bar as unknown as {
            bounds: { x1: number; y1: number; x2: number; y2: number };
            width: number;
            height: number;
        };
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) {
            expect(Number.isFinite(edge)).toBe(true);
        }
        expect(bounds.x2).toBeGreaterThan(bounds.x1);
        expect(bounds.y2).toBeGreaterThan(bounds.y1);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    }
}

/**
 * Asserts every bar's length is proportional to the value it should encode.
 *
 * Comparing each bar against the longest one removes the pixel scale, so this
 * only passes if the spec bound the intended field. A cohort toggle that
 * forgets to rebind `x` leaves plausible-looking bars whose lengths belong to
 * the wrong numbers — exactly what eyeballing a screenshot cannot detect.
 */
function expectBarsMatchValues(bars: SceneItem[], expected: Map<string, number>) {
    const widths = new Map(
        bars.map((bar) => {
            const { datum, width } = bar as unknown as { datum: Row; width: number };
            return [String(datum.Category), width];
        }),
    );
    expect([...widths.keys()].sort()).toEqual([...expected.keys()].sort());

    const widestBar = Math.max(...widths.values());
    const largestValue = Math.max(...expected.values());
    for (const [category, value] of expected) {
        expect(widths.get(category)! / widestBar).toBeCloseTo(value / largestValue, 6);
    }
}

const breakdownRows = taskBreakdownRows as Row[];
const usageRows = surfaceUsageRows as Row[];

describe("task breakdown renders", () => {
    it.each(taskDimensions)("draws one bar per $label category", async ({ id }) => {
        const { vegaLiteSpec, columnMetadata, dimension } = taskBreakdown({
            dimension: id as TaskDimension,
        });
        const lensRows = breakdownRows.filter((row) => row["[Dimension]"] === dimension);
        const bars = await renderBars(vegaLiteSpec, breakdownRows, columnMetadata);

        expect(lensRows.length).toBeGreaterThan(0);
        expectDrawableBars(bars, lensRows.length);
        expectBarsMatchValues(
            bars,
            new Map(lensRows.map((row) => [String(row["[Category]"]), row["[Tasks]"] as number])),
        );
    });

    it("keeps each lens to its own rows", () => {
        const lenses = new Set(breakdownRows.map((row) => row["[Dimension]"]));
        expect(lenses.size).toBe(taskDimensions.length);
    });
});

describe("surface usage renders", () => {
    const lenses: { id: UsageLens; lens: string }[] = [
        { id: "surface", lens: "Surface" },
        { id: "model", lens: "Model" },
    ];

    it.each(
        lenses.flatMap((lens) => workCohorts.map((cohort) => ({ ...lens, cohort }))),
    )("draws $lens bars for the $cohort.label cohort", async ({ id, lens, cohort }) => {
        const { vegaLiteSpec, columnMetadata } = surfaceUsage({ lens: id, cohort: cohort.id });
        const field = cohortTaskField(cohort.id);
        const plotted = usageRows.filter(
            (row) => row["[Lens]"] === lens && typeof row[`[${field}]`] === "number",
        );
        const bars = await renderBars(vegaLiteSpec, usageRows, columnMetadata);

        expect(plotted.length).toBeGreaterThan(0);
        expectDrawableBars(bars, plotted.length);
        expectBarsMatchValues(
            bars,
            new Map(plotted.map((row) => [String(row["[Category]"]), row[`[${field}]`] as number])),
        );
    });

    // Null task counts are real — a surface with no unlicensed use plots no bar,
    // so the expected count is only the rows that actually carry a number.
    it("has at least one null cohort value, so the null path is exercised", () => {
        const hasNull = usageRows.some((row) => row["[Unlicensed Tasks]"] === null);
        expect(hasNull).toBe(true);
    });
});

describe("leaderboard trees", () => {
    /** Rebuilds the positional `QueryTable` the SDK hands the app. */
    function asQueryTable(rows: Row[]): QueryTable {
        const names = Object.keys(rows[0]);
        return {
            columns: names.map((name) => ({ name, dataType: "string" })),
            rows: rows.map((row) => names.map((name) => row[name])),
        } as QueryTable;
    }

    const ORG = "Chat + Agent Org Data[Organization]";
    const peopleRows = leaderboardPeopleRows as Row[];

    function peopleTree(rows: Row[] = peopleRows) {
        return toLeaderboardPeopleTree(
            toDataTable(asQueryTable(rows), leaderboardPeople().columnMetadata),
            "Unassigned organization",
        );
    }

    const children = (row: GridRow) => (row._children as GridRow[] | undefined) ?? [];

    it("folds each organization over its people, busiest first", () => {
        const { rows } = peopleTree();

        expect(rows.map((row) => row[LEADERBOARD_LABEL_COLUMN])).toEqual(["Sales", "IT"]);
        for (const group of rows) {
            expect(isGroupRow(group)).toBe(true);
            const people = children(group);
            expect(people.length).toBeGreaterThan(0);
            const sessions = people.map((person) => person.Sessions as number);
            expect(sessions).toEqual([...sessions].sort((a, b) => b - a));
            for (const person of people) expect(String(person[LEADERBOARD_LABEL_COLUMN])).toMatch(/@/);
        }
    });

    // The fixture holds a slice of the ranking, so the model's total is
    // necessarily larger than anything summed from the rows it ships with.
    it("carries the grand total and subtotals the model reports, not client-side sums", () => {
        const { rows, total } = peopleTree();

        expect(total?.Sessions).toBe(6300);
        expect(total?.["Active Users"]).toBe(180);
        const sales = rows[0];
        expect(sales.Sessions).toBe(1655);
        const sliceSum = children(sales).reduce((sum, person) => sum + (person.Sessions as number), 0);
        expect(sales.Sessions).toBeGreaterThan(sliceSum);
    });

    it("names people missing from the org data instead of leaving a blank row", () => {
        const unassigned = peopleRows.map((row) => (row[ORG] === "IT" ? { ...row, [ORG]: null } : row));
        const { rows } = peopleTree(unassigned);

        expect(rows.map((row) => row[LEADERBOARD_LABEL_COLUMN])).toEqual(["Sales", "Unassigned organization"]);
        expect(children(rows[1]).length).toBeGreaterThan(0);
    });

    it("folds each app over the activities done there", () => {
        const source = leaderboardTasks("all");
        const { rows, total } = toLeaderboardTaskTree(
            toDataTable(asQueryTable(leaderboardTaskRows as Row[]), source.columnMetadata),
            source.levels,
        );

        expect(rows.map((row) => row[LEADERBOARD_LABEL_COLUMN])).toEqual(["autonomous", "Excel", "PowerPoint"]);
        expect(total?.Sessions).toBe(6300);
        for (const group of rows) {
            expect(children(group).length).toBeGreaterThan(0);
            for (const activity of children(group)) expect(isGroupRow(activity)).toBe(false);
        }
    });
});
