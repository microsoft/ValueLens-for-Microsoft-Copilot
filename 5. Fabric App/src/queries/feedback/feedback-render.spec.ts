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
import { feedbackCategory } from "./feedback-category";
import { feedbackSurface } from "./feedback-surface";
import { feedbackTrend } from "./feedback-trend";
import categoryRows from "./__fixtures__/feedback-category.rows.json";
import surfaceRows from "./__fixtures__/feedback-surface.rows.json";
import trendRows from "./__fixtures__/feedback-trend.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Bar {
    datum: Row;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Renders a spec the way the app does and returns its bar geometry. Fixture
 * rows use raw DAX names, then are renamed to the cleaned `ColumnDef.name`
 * values that `VegaVisual` hands Vega.
 */
async function renderBars(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap): Promise<Bar[]> {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 620, height: 400, data: { values } } as TopLevelSpec;
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

/** Horizontal bar lengths must stay proportional to the field they encode. */
function expectWidthsProportional(bars: Bar[], valueField: string) {
    const widest = Math.max(...bars.map((bar) => bar.width));
    const largest = Math.max(...bars.map((bar) => bar.datum[valueField] as number));
    for (const bar of bars) {
        expect(bar.width / widest).toBeCloseTo((bar.datum[valueField] as number) / largest, 6);
    }
}

/** Diverging vertical bars use magnitude, regardless of positive or negative sign. */
function expectHeightsProportionalToMagnitude(bars: Bar[], valueField: string) {
    const tallest = Math.max(...bars.map((bar) => bar.height));
    const largest = Math.max(...bars.map((bar) => Math.abs(bar.datum[valueField] as number)));
    for (const bar of bars) {
        expect(bar.height / tallest).toBeCloseTo(Math.abs(bar.datum[valueField] as number) / largest, 6);
    }
}

describe("feedback trend renders", () => {
    const rows = trendRows as Row[];

    it("draws one diverging bar for each weekly feedback type", async () => {
        const { vegaLiteSpec, columnMetadata } = feedbackTrend();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expectHeightsProportionalToMagnitude(bars, "Signed Count");
    });
});

describe("feedback category renders", () => {
    const rows = categoryRows as Row[];

    it("draws one segment per category and feedback type, sized by count", async () => {
        const { vegaLiteSpec, columnMetadata } = feedbackCategory();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expectWidthsProportional(bars, "Count");
    });

    it("puts the largest category at the top", async () => {
        const { vegaLiteSpec, columnMetadata } = feedbackCategory();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));

        expect(top.datum.Category).toBe("Apps & Productivity");
    });
});

describe("feedback surface renders", () => {
    const rows = surfaceRows as Row[];

    it("draws one bar per surface, sized by satisfaction", async () => {
        const { vegaLiteSpec, columnMetadata } = feedbackSurface();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expectWidthsProportional(bars, "Satisfaction");
    });

    it("puts the highest-satisfaction surface at the top", async () => {
        const { vegaLiteSpec, columnMetadata } = feedbackSurface();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));

        expect(top.datum["Surface / Agent"]).toBe("Agent A");
    });
});
