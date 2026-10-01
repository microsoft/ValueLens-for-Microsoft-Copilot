//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { compile } from "vega-lite";
import { parse, View, type Scene, type SceneItem } from "vega";
import type { TopLevelSpec } from "vega-lite";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { trendHeatmap } from "./trend-heatmap";
import heatmapRows from "./__fixtures__/trend-heatmap.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Rect {
    datum: Row;
    fill?: string;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

async function renderRects(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap, valueField: string) {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 600, height: 320, data: { values } } as TopLevelSpec;
    const view = new View(parse(compile(sized).spec), { renderer: "none" });
    await view.runAsync();

    const rects: SceneItem[] = [];
    const walk = (node: Scene | SceneItem) => {
        const scene = node as Scene;
        if (scene.marktype === "rect") rects.push(...(scene.items as SceneItem[]));
        for (const item of (scene.items ?? []) as (Scene | SceneItem)[]) {
            if ((item as Scene).marktype || (item as { items?: unknown }).items) walk(item);
        }
    };
    walk((view.scenegraph() as unknown as { root: Scene }).root);
    await view.finalize();

    return (rects as unknown as Rect[]).filter((rect) => rect.datum && valueField in rect.datum);
}

function expectDrawable(rects: Rect[], expectedCount: number) {
    expect(rects).toHaveLength(expectedCount);
    for (const { bounds, width, height } of rects) {
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) {
            expect(Number.isFinite(edge)).toBe(true);
        }
        expect(bounds.x2).toBeGreaterThan(bounds.x1);
        expect(bounds.y2).toBeGreaterThan(bounds.y1);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    }
}

describe("adoption trend heatmap renders", () => {
    const rows = heatmapRows as Row[];

    it("draws one cell per organization and week", async () => {
        const { vegaLiteSpec, columnMetadata } = trendHeatmap();
        const rects = await renderRects(vegaLiteSpec, rows, columnMetadata, "Active Users");

        expectDrawable(rects, rows.length);
    });

    it("orders organizations by the selected metric total", async () => {
        const { vegaLiteSpec, columnMetadata } = trendHeatmap({ metric: "activeUsers" });
        const rects = await renderRects(vegaLiteSpec, rows, columnMetadata, "Active Users");

        const tops = new Map<string, number>();
        for (const rect of rects) {
            const organization = String(rect.datum["Chat + Agent Org DataOrganization"]);
            tops.set(organization, Math.min(tops.get(organization) ?? Infinity, rect.bounds.y1));
        }

        const byPosition = [...tops.entries()].sort((a, b) => a[1] - b[1]).map(([organization]) => organization);
        expect(byPosition).toEqual(["Finance", "Sales", "HR"]);
    });

    it("maps different metric values to different cell colours", async () => {
        const { vegaLiteSpec, columnMetadata } = trendHeatmap({ metric: "sessions" });
        const rects = await renderRects(vegaLiteSpec, rows, columnMetadata, "Sessions Per User");

        const min = rects.reduce((lowest, rect) =>
            (rect.datum["Sessions Per User"] as number) < (lowest.datum["Sessions Per User"] as number)
                ? rect
                : lowest,
        );
        const max = rects.reduce((highest, rect) =>
            (rect.datum["Sessions Per User"] as number) > (highest.datum["Sessions Per User"] as number)
                ? rect
                : highest,
        );

        expect(max.fill).toBeDefined();
        expect(min.fill).toBeDefined();
        expect(max.fill).not.toBe(min.fill);
    });
});
