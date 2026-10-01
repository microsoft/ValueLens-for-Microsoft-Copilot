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
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { toValueTaskTree, valueByTask } from "./value-by-task";
import { toDataTable } from "@/lib/to-data-table";
import { liveColumns } from "./live-columns.fixture";
import taskRows from "./__fixtures__/value-by-task.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Bar {
    datum: Row;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/** Renders a spec the way the app does and returns its bar geometry. */
async function renderBars(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap): Promise<Bar[]> {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

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
    return bars as unknown as Bar[];
}

function expectDrawable(bars: Bar[], expectedCount: number) {
    expect(bars).toHaveLength(expectedCount);
    for (const { bounds, width, height } of bars) {
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) {
            expect(Number.isFinite(edge)).toBe(true);
        }
        expect(bounds.x2).toBeGreaterThan(bounds.x1);
        expect(bounds.y2).toBeGreaterThan(bounds.y1);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    }
}

/** Every bar's length relative to the longest must match its value relative to the largest. */
function expectProportional(bars: Bar[], valueField: string) {
    const widest = Math.max(...bars.map((bar) => bar.width));
    const largest = Math.max(...bars.map((bar) => bar.datum[valueField] as number));
    for (const bar of bars) {
        expect(bar.width / widest).toBeCloseTo((bar.datum[valueField] as number) / largest, 6);
    }
}

describe("time saved by task renders", () => {
    const { vegaLiteSpec, columnMetadata } = valueByTask();
    const table = toDataTable(
        {
            columns: liveColumns.valueByTask.map((name) => ({ name })),
            rows: (taskRows as Row[]).map((row) => liveColumns.valueByTask.map((name) => row[name])),
        } as never,
        columnMetadata,
    );
    const { tasks } = toValueTaskTree(table);
    // The chart receives the task table directly, already renamed.
    const rows = tasks.rows.map((row) => Object.fromEntries(tasks.columns.map((column, i) => [column.name, row[i]]))) as Row[];
    const identity = Object.fromEntries(tasks.columns.map((column) => [column.name, { name: column.name }]));

    it("draws one bar per task, sized by expert-equivalent hours per week", async () => {
        const bars = await renderBars(vegaLiteSpec, rows, identity);

        expectDrawable(bars, rows.length);
        expectProportional(bars, "Expert Equivalent Hours Per Week");
    });

    it("puts the task with the most hours per week at the top", async () => {
        const bars = await renderBars(vegaLiteSpec, rows, identity);
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
        expect(top.datum["Expert Equivalent Hours Per Week"]).toBe(
            Math.max(...rows.map((row) => row["Expert Equivalent Hours Per Week"] as number)),
        );
    });
});
