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
import type { DataTable } from "@microsoft/fabric-visuals-core";
import {
    applyExposureTheme,
    completeExposureGrid,
    EXPOSURE_ACCESS,
    EXPOSURE_SCOPES,
    governanceExposure,
    soleExposureAccess,
} from "./governance-exposure";
import { governanceOwners } from "./governance-owners";
import { EXPOSURE_ACCESS_WITH_WEB, PUBLIC_WEB, withPublicWeb } from "./governance-public-web";
import exposureRows from "./__fixtures__/governance-exposure.rows.json";
import ownerRows from "./__fixtures__/governance-owners.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Mark {
    datum: Row;
    width: number;
    height: number;
    fill?: string;
    text?: string;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

/** Renders a spec the way the app does and returns the items of one mark type, rects by default. */
async function renderRects(
    spec: unknown,
    rows: Row[],
    columnMetadata: ColumnMetadataMap,
    marktype = "rect",
): Promise<Mark[]> {
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
        if (scene.marktype === marktype && scene.role === "mark") rects.push(...(scene.items as SceneItem[]));
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

    /** The fixture as the app holds it: a DataTable in the chart's own column names. */
    function exposureTable(source: Row[]): DataTable {
        const { columnMetadata } = governanceExposure();
        const keys = Object.keys(columnMetadata);
        return {
            columns: keys.map((key) => columnMetadata[key]),
            rows: source.map((row) => keys.map((key) => row[key] ?? null)),
        };
    }

    function asRows(table: DataTable): Row[] {
        return table.rows.map((row) =>
            Object.fromEntries(table.columns.map((column, index) => [column.name, row[index] as Row[string]])),
        );
    }

    it("always draws every data access column and core sharing scope", async () => {
        const onlyNotReported = rows
            .filter((row) => row["[Sharing Scope]"] === "Whole organisation")
            .map((row) => ({ ...row, "[Access Order]": 4, "[Data Access]": "Not reported" }))
            .slice(0, 1);
        const grid = asRows(completeExposureGrid(exposureTable(onlyNotReported)));
        const cells = await renderRects(governanceExposure().vegaLiteSpec, grid, {});

        expectDrawable(cells, EXPOSURE_SCOPES.length * EXPOSURE_ACCESS.length);
        const left = Math.min(...cells.map((cell) => cell.bounds.x1));
        const columns = [...new Map(cells.map((cell) => [cell.bounds.x1, cell.datum["Data Access"]])).entries()]
            .sort(([a], [b]) => a - b)
            .map(([, access]) => access);
        expect(columns).toEqual([...EXPOSURE_ACCESS]);
        expect(cells.find((cell) => cell.bounds.x1 === left)?.datum.Agents).toBe(0);
    });

    it("adds a public web column last once Resource Graph reports web search", async () => {
        const web = [{ "[Scope Order]": 1, "[Sharing Scope]": "Whole organisation", "[Access Order]": 5, "[Data Access]": PUBLIC_WEB, "[Agents]": 2, "[Unused Agents]": 0 }];
        const table = withPublicWeb(exposureTable(rows), exposureTable(web));
        const grid = asRows(completeExposureGrid(table, EXPOSURE_ACCESS_WITH_WEB));
        const cells = await renderRects(governanceExposure().vegaLiteSpec, grid, {});

        expectDrawable(cells, EXPOSURE_SCOPES.length * EXPOSURE_ACCESS_WITH_WEB.length);
        const right = Math.max(...cells.map((cell) => cell.bounds.x1));
        for (const cell of cells.filter((item) => item.bounds.x1 === right)) {
            expect(cell.datum["Data Access"]).toBe(PUBLIC_WEB);
        }
    });

    it("keeps a scope the registry adds, and labels only the cells that hold agents", async () => {
        const withNotStated = [
            ...rows,
            { "[Scope Order]": 4, "[Sharing Scope]": "Not stated", "[Access Order]": 4, "[Data Access]": "Not reported", "[Agents]": 2, "[Unused Agents]": 1 },
        ];
        const grid = asRows(completeExposureGrid(exposureTable(withNotStated)));
        const spec = governanceExposure().vegaLiteSpec;

        expectDrawable(await renderRects(spec, grid, {}), 4 * EXPOSURE_ACCESS.length);
        const labels = await renderRects(spec, grid, {}, "text");
        expect(labels).toHaveLength(withNotStated.length);
        expect(labels.every((label) => Number(label.datum.Agents) > 0)).toBe(true);
    });

    it("names the single data access column only when every agent sits in it", () => {
        expect(soleExposureAccess(exposureTable(rows))).toBeUndefined();
        const notReported = rows.map((row) => ({ ...row, "[Access Order]": 4, "[Data Access]": "Not reported" }));
        expect(soleExposureAccess(completeExposureGrid(exposureTable(notReported)))).toBe("Not reported");
    });

    it.each([
        { theme: "light", quiet: "#f5f5f5", strong: "#0f6cbd", text: "#242424", page: "#fafafa" },
        { theme: "dark", quiet: "#333333", strong: "#479ef5", text: "#ffffff", page: "#1f1f1f" },
    ])("labels each cell in the text colour that reads best on it in the $theme theme", async (colors) => {
        const spec = applyExposureTheme(governanceExposure().vegaLiteSpec, {
            quiet: colors.quiet,
            strong: colors.strong,
            quietText: colors.text,
            strongText: colors.page,
        });
        const labels = await renderRects(spec, asRows(exposureTable(rows)), {}, "text");
        const most = Math.max(...labels.map((label) => Number(label.datum.Agents)));
        const least = Math.min(...labels.map((label) => Number(label.datum.Agents)));

        const strongest = labels.find((label) => Number(label.datum.Agents) === most);
        const quietest = labels.find((label) => Number(label.datum.Agents) === least);
        // Page-coloured text on the full brand fill: white on blue in light mode, near-black on pale blue in dark.
        expect(strongest?.fill).toBe(colors.page);
        expect(quietest?.fill).toBe(colors.text);
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
