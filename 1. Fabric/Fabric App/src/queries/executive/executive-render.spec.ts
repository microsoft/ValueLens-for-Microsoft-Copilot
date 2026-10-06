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
import { compile, type TopLevelSpec } from "vega-lite";
import { parse, View, type Scene, type SceneItem } from "vega";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { executiveCredits, executiveMonths, executiveWorkKinds, FADED_OPACITY } from "./index";
import creditRows from "./__fixtures__/executive-credits.rows.json";
import monthRows from "./__fixtures__/executive-months.rows.json";
import workKindRows from "./__fixtures__/executive-work-kinds.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Mark {
    datum: Row;
    opacity?: number;
    fillOpacity?: number;
    text?: string;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/** Renders a spec the way the app does and returns its bars and labels. */
async function render(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap) {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 600, height: 300, data: { values } } as TopLevelSpec;
    const view = new View(parse(compile(sized).spec), { renderer: "none" });
    await view.runAsync();

    const bars: Mark[] = [];
    const labels: Mark[] = [];
    const walk = (node: Scene | SceneItem) => {
        const scene = node as Scene;
        const role = (scene as unknown as { role?: string }).role;
        if (scene.marktype === "rect" && role === "mark") bars.push(...(scene.items as unknown as Mark[]));
        if (scene.marktype === "text" && role === "mark") labels.push(...(scene.items as unknown as Mark[]));
        for (const item of (scene.items ?? []) as (Scene | SceneItem)[]) {
            if ((item as Scene).marktype || (item as { items?: unknown }).items) walk(item);
        }
    };
    walk((view.scenegraph() as unknown as { root: Scene }).root);
    await view.finalize();
    return { bars, labels };
}

function expectDrawable(bars: Mark[]) {
    for (const { bounds, width, height } of bars) {
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) expect(Number.isFinite(edge)).toBe(true);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    }
}

describe("the hours trend renders", () => {
    const months = ["Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026"];

    it("stacks one bar per source per month with work, and labels each month's total", async () => {
        const { vegaLiteSpec, columnMetadata } = executiveMonths({ months });
        const { bars, labels } = await render(vegaLiteSpec, monthRows as Row[], columnMetadata);

        // Cowork is blank in the demo model, so each month has two segments.
        expect(bars).toHaveLength(monthRows.length * 2);
        expectDrawable(bars);
        expect(labels.map((label) => label.text)).toEqual(["597", "783", "162"]);
    });

    it("keeps empty months on the axis so the two charts line up", async () => {
        const { vegaLiteSpec, columnMetadata } = executiveMonths({ months });
        const { bars } = await render(vegaLiteSpec, monthRows as Row[], columnMetadata);
        const firstBar = Math.min(...bars.map((bar) => bar.bounds.x1));
        // Three empty months sit to the left of May.
        expect(firstBar).toBeGreaterThan(600 * 0.4);
    });

    it("fades the months before the range", async () => {
        const { vegaLiteSpec, columnMetadata } = executiveMonths({ months, rangeMonth: "2026-06-01" });
        const { bars, labels } = await render(vegaLiteSpec, monthRows as Row[], columnMetadata);
        const may = bars.filter((bar) => bar.datum.Month === "May 2026");
        const later = bars.filter((bar) => bar.datum.Month !== "May 2026");

        expect(may.length).toBeGreaterThan(0);
        for (const bar of may) expect(bar.opacity).toBe(FADED_OPACITY);
        for (const bar of later) expect(bar.opacity).toBe(1);
        expect(labels.find((label) => label.text === "597")?.opacity).toBe(FADED_OPACITY);
    });
});

describe("the credits trend renders", () => {
    it("draws only the months and sources with credits", async () => {
        const { vegaLiteSpec, columnMetadata } = executiveCredits();
        const { bars, labels } = await render(vegaLiteSpec, creditRows as Row[], columnMetadata);
        const drawn = creditRows.flatMap((row) => [row["[Studio Credits]"], row["[Cowork Credits]"]]).filter((v) => (v ?? 0) > 0);

        expect(bars).toHaveLength(drawn.length);
        expectDrawable(bars);
        expect(labels.map((label) => label.text)).toEqual(["14.7k", "485k", "814k", "710k"]);
    });
});

describe("the kinds of work chart renders", () => {
    it("ranks the kinds of work by hours, longest first", async () => {
        const { vegaLiteSpec, columnMetadata } = executiveWorkKinds();
        const { bars } = await render(vegaLiteSpec, workKindRows as Row[], columnMetadata);
        const top = [...bars].sort((a, b) => a.bounds.y1 - b.bounds.y1);

        expect(bars).toHaveLength(workKindRows.length);
        expectDrawable(bars);
        expect(top.map((bar) => bar.datum.Hours)).toEqual([...workKindRows.map((row) => row["[Hours]"])].sort((a, b) => b - a));
        const widest = Math.max(...bars.map((bar) => bar.width));
        for (const bar of bars) expect(bar.width / widest).toBeCloseTo((bar.datum.Hours as number) / 438.5, 6);
    });
});
