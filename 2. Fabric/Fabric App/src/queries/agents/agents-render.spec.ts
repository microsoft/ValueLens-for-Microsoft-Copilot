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
import { agentLifecycle } from "./agent-lifecycle";
import { agentUsage } from "./agent-usage";
import { coworkReadinessByOrg } from "./cowork-readiness-by-org";
import lifecycleRows from "./__fixtures__/agent-lifecycle.rows.json";
import usageRows from "./__fixtures__/agent-usage.rows.json";
import readinessRows from "./__fixtures__/cowork-readiness-by-org.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Bar {
    datum: Row;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Renders a spec the way the app does and returns its bar geometry. Rows are
 * renamed to the cleaned `ColumnDef.name` keys `VegaVisual` hands Vega; see
 * `work-render.spec.ts` for why `renderer: "none"` is enough.
 */
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

describe("agent usage renders", () => {
    const rows = usageRows as Row[];

    it("draws one bar per agent, sized by sessions", async () => {
        const { vegaLiteSpec, columnMetadata } = agentUsage();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expectProportional(bars, "Sessions");
        expect(bars.map((bar) => bar.datum.Agent).sort()).toEqual(rows.map((row) => row["[Agent]"]).sort());
    });

    it("puts the busiest agent at the top", async () => {
        const { vegaLiteSpec, columnMetadata } = agentUsage();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
        expect(top.datum.Sessions).toBe(Math.max(...rows.map((row) => row["[Sessions]"] as number)));
    });
});

describe("agent lifecycle renders", () => {
    const rows = lifecycleRows as Row[];

    it("draws one segment per lifecycle and agent type", async () => {
        const { vegaLiteSpec, columnMetadata } = agentLifecycle();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expectProportional(bars, "Agents");
    });

    it("stacks each lifecycle to its total", async () => {
        const { vegaLiteSpec, columnMetadata } = agentLifecycle();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        const totals = new Map<string, { agents: number; width: number }>();
        for (const bar of bars) {
            const key = String(bar.datum.Lifecycle);
            const entry = totals.get(key) ?? { agents: 0, width: 0 };
            totals.set(key, { agents: entry.agents + (bar.datum.Agents as number), width: entry.width + bar.width });
        }
        const widest = Math.max(...[...totals.values()].map((entry) => entry.width));
        const largest = Math.max(...[...totals.values()].map((entry) => entry.agents));
        for (const { agents, width } of totals.values()) {
            expect(width / widest).toBeCloseTo(agents / largest, 6);
        }
    });

    it("keeps the lifecycle stages in the model's order, top to bottom", async () => {
        const { vegaLiteSpec, columnMetadata } = agentLifecycle();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        const tops = new Map<number, number>();
        for (const bar of bars) {
            const order = bar.datum["Lifecycle Order"] as number;
            tops.set(order, Math.min(tops.get(order) ?? Infinity, bar.bounds.y1));
        }
        const byPosition = [...tops.entries()].sort((a, b) => a[1] - b[1]).map(([order]) => order);
        expect(byPosition).toEqual([...byPosition].sort((a, b) => a - b));
    });
});

describe("cowork readiness by organization renders", () => {
    const rows = readinessRows as Row[];

    it("draws one bar per organization, sized by breadth of use", async () => {
        const { vegaLiteSpec, columnMetadata } = coworkReadinessByOrg();
        const bars = await renderBars(vegaLiteSpec, rows, columnMetadata);

        expectDrawable(bars, rows.length);
        expectProportional(bars, "Surfaces Per Day");
    });
});
