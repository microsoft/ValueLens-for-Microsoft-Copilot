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
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { toRollupDataTables } from "@/lib/to-data-table";
import { surfaceUsage, type UsageLens } from "./surface-usage";
import { taskBreakdown, taskDimensions, type TaskDimension } from "./task-breakdown";
import {
    userLeaderboard,
    ORGANIZATION_COLUMN,
    USER_COLUMN,
} from "./user-leaderboard";
import { workCohorts, cohortTaskField } from "./cohorts";
import taskBreakdownRows from "./__fixtures__/task-breakdown.rows.json";
import surfaceUsageRows from "./__fixtures__/surface-usage.rows.json";
import userLeaderboardRows from "./__fixtures__/user-leaderboard.rows.json";

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

describe("user leaderboard grid", () => {
    const leaderboardRows = userLeaderboardRows as Row[];

    /** Rebuilds the positional `QueryTable` the SDK hands the app. */
    function asQueryTable(rows: Row[]): QueryTable {
        const names = Object.keys(rows[0]);
        return {
            columns: names.map((name) => ({ name, dataType: "string" })),
            rows: rows.map((row) => names.map((name) => row[name])),
        } as QueryTable;
    }

    it("splits the grand total out of the body", () => {
        const { columnMetadata, rollupFlagColumns } = userLeaderboard();
        const { bodyTable, grandTotalTable } = toRollupDataTables(
            asQueryTable(leaderboardRows),
            columnMetadata,
            { rollupFlagColumns: [...rollupFlagColumns] },
        );

        expect(grandTotalTable.rows).toHaveLength(1);
        expect(bodyTable.rows).toHaveLength(leaderboardRows.length - 1);
        // The flag column is internal plumbing and must not reach the grid.
        expect(bodyTable.columns.map((column) => column.name)).not.toContain("[IsTotal]");
    });

    it("gives the grid the column ids the cohort toggle hides by", () => {
        const { columnMetadata, rollupFlagColumns } = userLeaderboard();
        const { bodyTable } = toRollupDataTables(asQueryTable(leaderboardRows), columnMetadata, {
            rollupFlagColumns: [...rollupFlagColumns],
        });
        const names = bodyTable.columns.map((column) => column.name);

        expect(names).toContain(ORGANIZATION_COLUMN);
        expect(names).toContain(USER_COLUMN);
        for (const cohort of workCohorts) {
            expect(names).toContain(cohortTaskField(cohort.id));
        }
    });

    it("carries the grand total the model reports, not a client-side sum", () => {
        const { columnMetadata, rollupFlagColumns } = userLeaderboard();
        const { grandTotalTable } = toRollupDataTables(
            asQueryTable(leaderboardRows),
            columnMetadata,
            { rollupFlagColumns: [...rollupFlagColumns] },
        );
        const total = grandTotalTable.rows[0] as unknown[];
        const allTasks = grandTotalTable.columns.findIndex((c) => c.name === "All Tasks");

        // The fixture holds a slice of the leaderboard, so the total is
        // necessarily larger than the detail rows it ships with.
        const sliceSum = leaderboardRows
            .filter((row) => row["[IsTotal]"] === false)
            .reduce((sum, row) => sum + (row["[All Tasks]"] as number), 0);
        expect(total[allTasks]).toBe(6300);
        expect(total[allTasks]).toBeGreaterThan(sliceSum);
    });
});
