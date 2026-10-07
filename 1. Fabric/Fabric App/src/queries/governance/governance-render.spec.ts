//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// @vitest-environment node
// Vega builds the full scenegraph without a DOM; see agents-render.spec.ts.

import { describe, expect, it } from "vitest";
import { compile } from "vega-lite";
import { parse, View, type Scene, type SceneItem } from "vega";
import type { TopLevelSpec } from "vega-lite";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { governanceExposure } from "./governance-exposure";
import { governanceOwners } from "./governance-owners";
import exposureRows from "./__fixtures__/governance-exposure.rows.json";
import ownerRows from "./__fixtures__/governance-owners.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Mark {
    datum: Row;
    width: number;
    height: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/** Renders a spec the way the app does and returns its rect geometry. */
async function renderRects(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap): Promise<Mark[]> {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 600, height: 400, data: { values } } as TopLevelSpec;
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
    return rects as unknown as Mark[];
}

function expectDrawable(marks: Mark[], expectedCount: number) {
    expect(marks).toHaveLength(expectedCount);
    for (const { bounds, width, height } of marks) {
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) {
            expect(Number.isFinite(edge)).toBe(true);
        }
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
    }
}

describe("governance exposure renders", () => {
    const rows = exposureRows as Row[];

    it("draws one cell per sharing scope and data access pair", async () => {
        const { vegaLiteSpec, columnMetadata } = governanceExposure();
        expectDrawable(await renderRects(vegaLiteSpec, rows, columnMetadata), rows.length);
    });

    it("puts whole-organisation sharing on the top row and organisation content in the first column", async () => {
        const { vegaLiteSpec, columnMetadata } = governanceExposure();
        const cells = await renderRects(vegaLiteSpec, rows, columnMetadata);
        const top = Math.min(...cells.map((cell) => cell.bounds.y1));
        const left = Math.min(...cells.map((cell) => cell.bounds.x1));
        for (const cell of cells.filter((item) => item.bounds.y1 === top)) {
            expect(cell.datum["Sharing Scope"]).toBe("Whole organisation");
        }
        for (const cell of cells.filter((item) => item.bounds.x1 === left)) {
            expect(cell.datum["Data Access"]).toBe("Organisation content");
        }
    });
});

describe("governance owners renders", () => {
    const rows = ownerRows as Row[];

    it("draws one bar per owner status, sized by agents", async () => {
        const { vegaLiteSpec, columnMetadata } = governanceOwners();
        const bars = await renderRects(vegaLiteSpec, rows, columnMetadata);
        expectDrawable(bars, rows.length);

        const widest = Math.max(...bars.map((bar) => bar.width));
        const largest = Math.max(...bars.map((bar) => bar.datum.Agents as number));
        for (const bar of bars) {
            expect(bar.width / widest).toBeCloseTo((bar.datum.Agents as number) / largest, 6);
        }
    });

    it("keeps the statuses in order, active owners first", async () => {
        const { vegaLiteSpec, columnMetadata } = governanceOwners();
        const bars = await renderRects(vegaLiteSpec, rows, columnMetadata);
        const order = [...bars].sort((a, b) => a.bounds.y1 - b.bounds.y1).map((bar) => bar.datum["Owner Status"]);
        expect(order).toEqual(rows.map((row) => row["[Owner Status]"]));
    });
});
