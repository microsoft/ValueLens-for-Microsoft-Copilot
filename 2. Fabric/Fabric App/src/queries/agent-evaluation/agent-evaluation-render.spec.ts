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
import { answerArchetypes, knowledgeSources, themeOutcomes } from "./conversations";
import { performanceErrors, performanceWeekly } from "./performance";
import archetypeRows from "./__fixtures__/answer-archetypes.rows.json";
import errorRows from "./__fixtures__/performance-errors.rows.json";
import sourceRows from "./__fixtures__/knowledge-sources.rows.json";
import themeRows from "./__fixtures__/theme-outcomes.rows.json";
import weeklyRows from "./__fixtures__/performance-weekly.rows.json";

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
    return bars.filter((bar) => (bar as unknown as Bar).datum) as unknown as Bar[];
}

function expectDrawable(bars: Bar[], expectedCount: number) {
    expect(bars).toHaveLength(expectedCount);
    for (const { bounds, width, height } of bars) {
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) {
            expect(Number.isFinite(edge)).toBe(true);
        }
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    }
}

function topBar(bars: Bar[]): Bar {
    return bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
}

describe("weekly outcomes render", () => {
    const rows = weeklyRows as Row[];

    it("stacks one segment per week and outcome, resolved at the base", async () => {
        const { vegaLiteSpec, columnMetadata } = performanceWeekly();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        const firstWeek = bars.filter((bar) => bar.datum["Week Start"] === rows[0]["[Week Start]"]);
        const lowest = firstWeek.reduce((low, bar) => (bar.bounds.y2 > low.bounds.y2 ? bar : low));
        expect(lowest.datum.Outcome).toBe("Resolved");
    });

    it("keeps weeks in date order", async () => {
        const { vegaLiteSpec, columnMetadata } = performanceWeekly();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const resolved = bars.filter((bar) => bar.datum.Outcome === "Resolved").sort((a, b) => a.bounds.x1 - b.bounds.x1);
        const weeks = resolved.map((bar) => String(bar.datum["Week Start"]));

        expect(weeks).toEqual([...weeks].sort());
    });
});

describe("theme outcomes render", () => {
    const rows = themeRows as Row[];

    it("stacks one segment per theme and outcome, busiest theme on top", async () => {
        const { vegaLiteSpec, columnMetadata } = themeOutcomes();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        const totals = new Map<string, number>();
        for (const row of rows) totals.set(String(row["[Theme]"]), (totals.get(String(row["[Theme]"])) ?? 0) + Number(row["[Conversations]"]));
        const busiest = [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
        expect(topBar(bars).datum.Theme).toBe(busiest);
    });
});

describe("ranked bar charts render", () => {
    it.each([
        { name: "errors", factory: performanceErrors, rows: errorRows as Row[], value: "Errors", label: "Error Code" },
        { name: "knowledge sources", factory: knowledgeSources, rows: sourceRows as Row[], value: "Citations", label: "Source" },
        { name: "answer archetypes", factory: answerArchetypes, rows: archetypeRows as Row[], value: "Conversations", label: "Archetype" },
    ])("$name draws one bar per row, largest on top and sized by value", async ({ factory, rows, value, label }) => {
        const { vegaLiteSpec, columnMetadata } = factory();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        const widest = Math.max(...bars.map((bar) => bar.width));
        const largest = Math.max(...bars.map((bar) => bar.datum[value] as number));
        for (const bar of bars) {
            expect(bar.width / widest).toBeCloseTo((bar.datum[value] as number) / largest, 6);
        }
        expect(topBar(bars).datum[label]).toBe(rows[0][`[${label}]`]);
    });
});
