//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parse, View, type Scene, type SceneItem } from "vega";
import { compile } from "vega-lite";
import type { TopLevelSpec } from "vega-lite";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { coworkFitByTask, modelMatchByTool, modelUsage } from "./index";
import byTaskRows from "./__fixtures__/cowork-fit-by-task.rows.json";
import matchRows from "./__fixtures__/model-match-by-tool.rows.json";
import usageRows from "./__fixtures__/model-usage.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Bar {
    datum: Row;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

async function renderBars(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap): Promise<Bar[]> {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 600, height: 320, data: { values } } as TopLevelSpec;
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

describe("model usage renders", () => {
    const rows = usageRows as Row[];

    it("draws one ranked bar per model", async () => {
        const { vegaLiteSpec, columnMetadata } = modelUsage();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
        expect(top.datum.Sessions).toBe(Math.max(...rows.map((row) => row["[Sessions]"] as number)));
    });

    it("sizes each model by sessions", async () => {
        const { vegaLiteSpec, columnMetadata } = modelUsage();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const widest = Math.max(...bars.map((bar) => bar.width));
        const largest = Math.max(...rows.map((row) => row["[Sessions]"] as number));

        for (const bar of bars) {
            expect(bar.width / widest).toBeCloseTo((bar.datum.Sessions as number) / largest, 6);
        }
    });
});

describe("model match by tool renders", () => {
    const rows = matchRows as Row[];

    it("draws one stacked segment per live outcome row", async () => {
        const { vegaLiteSpec, columnMetadata } = modelMatchByTool();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expect(bars.map((bar) => bar.datum.Outcome).sort()).toEqual(rows.map((row) => row["[Outcome]"]).sort());
    });

    it("normalizes every activity to the same total width", async () => {
        const { vegaLiteSpec, columnMetadata } = modelMatchByTool();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const totals = new Map<string, number>();

        for (const bar of bars) {
            const key = String(bar.datum.Activity);
            totals.set(key, (totals.get(key) ?? 0) + bar.width);
        }

        const widths = [...totals.values()];
        expect(widths.length).toBeGreaterThan(1);
        for (const width of widths.slice(1)) {
            expect(width / widths[0]).toBeCloseTo(1, 6);
        }
    });
});

describe("cowork fit by task renders", () => {
    const rows = byTaskRows as Row[];

    it("draws one segment per task and grade", async () => {
        const { vegaLiteSpec, columnMetadata } = coworkFitByTask();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
    });

    it("fills every task's row, since its grades share out all of its graded sessions", async () => {
        const { vegaLiteSpec, columnMetadata } = coworkFitByTask();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const totals = new Map<string, number>();
        for (const bar of bars) {
            const key = String(bar.datum.Task);
            totals.set(key, (totals.get(key) ?? 0) + bar.width);
        }

        expect(totals.size).toBe(new Set(rows.map((row) => row["[Task]"])).size);
        for (const width of totals.values()) {
            expect(width).toBeCloseTo(600, 3);
        }
    });

    it("puts the task with the most graded sessions at the top, Strong fit first", async () => {
        const { vegaLiteSpec, columnMetadata } = coworkFitByTask();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const top = Math.min(...bars.map((bar) => bar.bounds.y1));
        const busiest = rows.reduce((best, row) =>
            (row["[Task Sessions]"] as number) > (best["[Task Sessions]"] as number) ? row : best,
        );
        const topRow = bars.filter((bar) => bar.bounds.y1 === top);

        expect(new Set(topRow.map((bar) => bar.datum.Task))).toEqual(new Set([busiest["[Task]"]]));
        const leftmost = topRow.reduce((first, bar) => (bar.bounds.x1 < first.bounds.x1 ? bar : first));
        expect(leftmost.datum.Grade).toBe("Strong fit");
    });
});
