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
import { m365Apps } from "./m365-apps";
import { m365CopilotIndex } from "./m365-copilot-index";
import { m365WorkloadReach } from "./m365-workload-reach";
import { m365WorkloadTrend } from "./m365-workload-trend";
import appsRows from "./__fixtures__/m365-apps.rows.json";
import indexRows from "./__fixtures__/m365-copilot-index.rows.json";
import reachRows from "./__fixtures__/m365-workload-reach.rows.json";
import trendRows from "./__fixtures__/m365-workload-trend.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Mark {
    datum: Row;
    x?: number;
    y?: number;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Renders a spec the way the app does and returns the items of every mark of
 * the given type. Fixture rows use raw DAX names, then are renamed to the
 * cleaned `ColumnDef.name` values that `VegaVisual` hands Vega.
 */
async function renderMarks(
    spec: unknown,
    rows: Row[],
    columnMetadata: ColumnMetadataMap,
    marktype: string,
): Promise<Mark[]> {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 620, height: 400, data: { values } } as TopLevelSpec;
    const view = new View(parse(compile(sized).spec), { renderer: "none" });
    await view.runAsync();

    const found: SceneItem[] = [];
    const walk = (node: Scene | SceneItem) => {
        const scene = node as Scene;
        if (scene.marktype === marktype) found.push(...(scene.items as SceneItem[]));
        for (const item of (scene.items ?? []) as (Scene | SceneItem)[]) {
            if ((item as Scene).marktype || (item as { items?: unknown }).items) walk(item);
        }
    };
    walk((view.scenegraph() as unknown as { root: Scene }).root);
    await view.finalize();
    return found as unknown as Mark[];
}

function expectDrawable(bars: Mark[], expectedCount: number) {
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
function expectWidthsProportional(bars: Mark[], valueField: string) {
    const widest = Math.max(...bars.map((bar) => bar.width));
    const largest = Math.max(...bars.map((bar) => bar.datum[valueField] as number));
    for (const bar of bars) {
        expect(bar.width / widest).toBeCloseTo((bar.datum[valueField] as number) / largest, 6);
    }
}

function topmost(bars: Mark[]): Mark {
    return bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
}

describe("m365 workload trend renders", () => {
    const rows = trendRows as Row[];

    it("draws one point per week and workload, on a 0–100% scale", async () => {
        const { vegaLiteSpec, columnMetadata } = m365WorkloadTrend();
        const points = (await renderMarks(vegaLiteSpec, rows, columnMetadata, "symbol")).filter(
            (point) => point.datum?.Share !== undefined,
        );

        expect(points).toHaveLength(rows.length);
        for (const point of points) {
            expect(Number.isFinite(point.x)).toBe(true);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThanOrEqual(400);
        }
        const share = (point: Mark) => point.datum.Share as number;
        const highest = points.reduce((best, point) => (share(point) > share(best) ? point : best));
        const lowest = points.reduce((least, point) => (share(point) < share(least) ? point : least));
        expect(highest.y!).toBeLessThan(lowest.y!);
    });

    it("draws one line per workload", async () => {
        const { vegaLiteSpec, columnMetadata } = m365WorkloadTrend();
        const lines = await renderMarks(vegaLiteSpec, rows, columnMetadata, "line");

        expect(new Set(lines.map((line) => line.datum.Workload)).size).toBe(6);
    });
});

describe("m365 workload reach renders", () => {
    const rows = reachRows as Row[];

    it("draws one bar per workload, sized by reach", async () => {
        const { vegaLiteSpec, columnMetadata } = m365WorkloadReach();
        const bars = await renderMarks(vegaLiteSpec, rows, columnMetadata, "rect");

        expectDrawable(bars, rows.length);
        expectWidthsProportional(bars, "Reach");
        expect(topmost(bars).datum.Workload).toBe("Teams");
    });
});

describe("m365 apps renders", () => {
    const rows = appsRows as Row[];

    it("draws one bar per app, sized by reach", async () => {
        const { vegaLiteSpec, columnMetadata } = m365Apps();
        const bars = await renderMarks(vegaLiteSpec, rows, columnMetadata, "rect");

        expectDrawable(bars, rows.length);
        expectWidthsProportional(bars, "Reach");
        expect(topmost(bars).datum.App).toBe("Teams");
    });
});

describe("m365 copilot index renders", () => {
    const rows = indexRows as Row[];

    it("draws each bar from 1× out to its ratio", async () => {
        const { vegaLiteSpec, columnMetadata } = m365CopilotIndex();
        const bars = await renderMarks(vegaLiteSpec, rows, columnMetadata, "rect");

        expectDrawable(bars, rows.length);
        const widest = Math.max(...bars.map((bar) => bar.width));
        const furthest = Math.max(...bars.map((bar) => Math.abs((bar.datum.Index as number) - 1)));
        for (const bar of bars) {
            expect(bar.width / widest).toBeCloseTo(Math.abs((bar.datum.Index as number) - 1) / furthest, 6);
        }
    });

    it("shares one baseline at 1× between bars above and below it", async () => {
        const { vegaLiteSpec, columnMetadata } = m365CopilotIndex();
        const bars = await renderMarks(vegaLiteSpec, rows, columnMetadata, "rect");
        const [rule] = (await renderMarks(vegaLiteSpec, rows, columnMetadata, "rule")).filter(
            (item) => item.datum?.Metric !== undefined,
        );

        const above = bars.filter((bar) => (bar.datum.Index as number) > 1);
        const below = bars.filter((bar) => (bar.datum.Index as number) < 1);
        expect(above.length).toBeGreaterThan(0);
        expect(below.length).toBeGreaterThan(0);
        for (const bar of above) expect(bar.bounds.x1).toBeCloseTo(rule.x!, 6);
        for (const bar of below) expect(bar.bounds.x2).toBeCloseTo(rule.x!, 6);
    });

    it("leads with the biggest ratio", async () => {
        const { vegaLiteSpec, columnMetadata } = m365CopilotIndex();
        const bars = await renderMarks(vegaLiteSpec, rows, columnMetadata, "rect");

        expect(topmost(bars).datum.Metric).toBe("Chat messages");
    });
});
