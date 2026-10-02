//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { expressionFunction, parse, View, type Scene, type SceneItem } from "vega";
import { compile } from "vega-lite";
import type { TopLevelSpec } from "vega-lite";
import { formatValue } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionByProduct, coworkWeekly, foundryByModel, foundryDaily, studioBreakdown, studioDaily } from "./index";
import productRows from "./__fixtures__/consumption-by-product.rows.json";
import weeklyRows from "./__fixtures__/cowork-weekly.rows.json";
import modelRows from "./__fixtures__/foundry-by-model.rows.json";
import foundryDailyRows from "./__fixtures__/foundry-daily.rows.json";
import breakdownRows from "./__fixtures__/studio-breakdown.rows.json";
import studioDailyRows from "./__fixtures__/studio-daily.rows.json";

type Row = Record<string, string | number | boolean | null>;

interface Mark {
    datum: Row;
    width?: number;
    height?: number;
    bounds: { x1: number; y1: number; x2: number; y2: number };
}

async function render(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap, marktype: string): Promise<Mark[]> {
    const view = await run(spec, rows, columnMetadata);
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

/** The numeric tick labels the app prints on the chart's value axis. */
async function valueAxisLabels(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap): Promise<string[]> {
    const view = await run(asVegaVisual(spec, columnMetadata), rows, columnMetadata);
    const labels: string[] = [];
    const walk = (node: Scene | SceneItem) => {
        const scene = node as Scene & { role?: string };
        if (scene.role === "axis-label") labels.push(...(scene.items as unknown as { text: string }[]).map((item) => item.text));
        for (const item of (scene.items ?? []) as (Scene | SceneItem)[]) {
            if ((item as Scene).marktype || (item as { items?: unknown }).items) walk(item);
        }
    };
    walk((view.scenegraph() as unknown as { root: Scene }).root);
    await view.finalize();
    return labels.filter((text) => /^[\d.,]+[KMB]?$/.test(text));
}

expressionFunction("vbaFormat", (value: unknown, format: string) => String(formatValue(value, format)));
expressionFunction("compactFormat", (value: unknown, format: string) => String(formatValue(value, format, { compact: true })));

type AxisDef = Record<string, unknown>;
type Encoding = Record<string, { field?: string; type?: string; axis?: AxisDef | null }>;

/**
 * VegaVisual rewrites quantitative axes before Vega sees them: an axis with no
 * formatType takes its column's format string, and an axis with no labelExpr in
 * that format is then printed compactly. Applies the same two rules, so the
 * labels here are the ones the app draws.
 */
function asVegaVisual(spec: unknown, columnMetadata: ColumnMetadataMap): unknown {
    const formats = new Map(Object.values(columnMetadata).map((column) => [column.name, column.format]));
    const rewrite = (encoding: Encoding) => {
        const result = { ...encoding };
        for (const channel of ["x", "y"]) {
            const def = result[channel];
            if (!def || def.type !== "quantitative" || def.axis === null) continue;
            let axis: AxisDef = { ...def.axis };
            const format = def.field === undefined ? undefined : formats.get(def.field);
            if (format !== undefined && axis.formatType === undefined) axis = { ...axis, format, formatType: "vbaFormat" };
            if (axis.labelExpr === undefined && (axis.formatType === "vbaFormat" || axis.format === undefined)) {
                const vba = axis.formatType === "vbaFormat" ? axis.format : "";
                axis = { ...axis, labelExpr: `compactFormat(datum.value, ${JSON.stringify(vba ?? "")})` };
            }
            result[channel] = { ...def, axis };
        }
        return result;
    };
    const source = spec as { encoding?: Encoding; layer?: { encoding?: Encoding }[]; config?: object };
    const rewritten: Record<string, unknown> = { ...source, config: { ...source.config, customFormatTypes: true } };
    if (source.encoding) rewritten.encoding = rewrite(source.encoding);
    if (source.layer) rewritten.layer = source.layer.map((layer) => (layer.encoding ? { ...layer, encoding: rewrite(layer.encoding) } : layer));
    return rewritten;
}

async function run(spec: unknown, rows: Row[], columnMetadata: ColumnMetadataMap): Promise<View> {
    const rename = new Map(Object.entries(columnMetadata).map(([daxName, column]) => [daxName, column.name]));
    const values = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [rename.get(key) ?? key, value])),
    );

    const sized = { ...(spec as object), width: 600, height: 320, data: { values } } as TopLevelSpec;
    const view = new View(parse(compile(sized).spec), { renderer: "none" });
    await view.runAsync();
    return view;
}

/** Scales every cost in the rows, to stand in for a tenant that has barely spent. */
function scaleCosts(rows: Row[], factor: number): Row[] {
    return rows.map((row) =>
        Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, /Cost\]$/.test(key) && typeof value === "number" ? value * factor : value]),
        ),
    );
}

function expectFinite(marks: Mark[]) {
    for (const { bounds } of marks) {
        for (const edge of [bounds.x1, bounds.y1, bounds.x2, bounds.y2]) {
            expect(Number.isFinite(edge)).toBe(true);
        }
    }
}

const count = (rows: Row[], column: string) => rows.filter((row) => typeof row[column] === "number").length;

describe("cost by product renders", () => {
    it("draws a bar for each product with a cost, in the report's product order", async () => {
        const rows = productRows as Row[];
        const { vegaLiteSpec, columnMetadata } = consumptionByProduct();
        const bars = await render(vegaLiteSpec, rows, columnMetadata, "rect");

        expect(bars).toHaveLength(count(rows, "[Cost]"));
        expectFinite(bars);
        const order = [...bars].sort((a, b) => a.bounds.y1 - b.bounds.y1).map((bar) => bar.datum.Product);
        expect(order).toEqual(rows.filter((row) => typeof row["[Cost]"] === "number").map((row) => row["[Product]"]));
    });
});

describe("cowork weekly renders", () => {
    const rows = weeklyRows as Row[];

    it("plots credits for every week in the export", async () => {
        const { vegaLiteSpec, columnMetadata } = coworkWeekly("consumption");
        const points = await render(vegaLiteSpec, rows, columnMetadata, "symbol");
        expect(points).toHaveLength(count(rows, "[Credits]"));
        expectFinite(points);
    });

    it("stacks prepaid and pay-as-you-go cost only for the weeks the period prices", async () => {
        const { vegaLiteSpec, columnMetadata } = coworkWeekly("cost");
        const bars = await render(vegaLiteSpec, rows, columnMetadata, "rect");
        expect(bars).toHaveLength(count(rows, "[Prepaid Cost]") + count(rows, "[PAYG Cost]"));
        expectFinite(bars);
        expect(new Set(bars.map((bar) => bar.datum.Billing))).toEqual(new Set(["Prepaid", "Pay-as-you-go"]));
    });
});

describe("studio daily renders", () => {
    const rows = studioDailyRows as Row[];

    it.each(["consumption", "cost"] as const)("stacks prepaid and pay-as-you-go %s for each day", async (lens) => {
        const { vegaLiteSpec, columnMetadata } = studioDaily(lens);
        const [prepaid, payg] = lens === "cost" ? ["[Prepaid Cost]", "[PAYG Cost]"] : ["[Prepaid Credits]", "[PAYG Credits]"];
        const bars = await render(vegaLiteSpec, rows, columnMetadata, "rect");
        expect(bars).toHaveLength(count(rows, prepaid) + count(rows, payg));
        expectFinite(bars);
        const days = [...new Set([...bars].sort((a, b) => a.bounds.x1 - b.bounds.x1).map((bar) => bar.datum["Usage Date"]))];
        expect(days).toEqual(rows.map((row) => row["[Usage Date]"]));
    });
});

describe("studio breakdown renders", () => {
    it("ranks the items by the lens's measure", async () => {
        const rows = (breakdownRows as Row[]).filter((row) => row["[Breakdown]"] === "Model");
        const { vegaLiteSpec, columnMetadata } = studioBreakdown("cost");
        const bars = await render(vegaLiteSpec, rows, columnMetadata, "rect");
        expect(bars).toHaveLength(count(rows, "[Cost]"));
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
        expect(top.datum.Cost).toBe(Math.max(...rows.map((row) => row["[Cost]"] as number)));
    });
});

describe("azure renders", () => {
    it("stacks each day's cost by component", async () => {
        const rows = foundryDailyRows as Row[];
        const { vegaLiteSpec, columnMetadata } = foundryDaily();
        const symbols = await render(vegaLiteSpec, rows, columnMetadata, "symbol");
        // Legend swatches are symbols too; keep only the plotted points.
        const points = symbols.filter((symbol) => symbol.datum && "Cost" in symbol.datum);
        const areas = await render(vegaLiteSpec, rows, columnMetadata, "area");
        expect(points).toHaveLength(count(rows, "[Cost]"));
        expect(areas.length).toBeGreaterThan(0);
        expectFinite(points);
        // Stacked: on any day, output tokens sit above input tokens.
        const day = rows[0]["[Usage Date]"];
        const [input, output] = ["Input tokens", "Output tokens"].map((component) =>
            points.find((point) => point.datum["Usage Date"] === day && point.datum.Component === component),
        );
        expect(output!.bounds.y1).toBeLessThan(input!.bounds.y1);
    });

    it("ranks models by cost", async () => {
        const rows = modelRows as Row[];
        const { vegaLiteSpec, columnMetadata } = foundryByModel();
        const bars = await render(vegaLiteSpec, rows, columnMetadata, "rect");
        expect(bars).toHaveLength(rows.length);
        const top = bars.reduce((first, bar) => (bar.bounds.y1 < first.bounds.y1 ? bar : first));
        expect(top.datum.Item).toBe(rows[0]["[Item]"]);
    });
});

describe("cost axes", () => {
    const charts = [
        { name: "cost by product", factory: () => consumptionByProduct(), rows: productRows as Row[] },
        { name: "cowork weekly cost", factory: () => coworkWeekly("cost"), rows: weeklyRows as Row[] },
        { name: "studio daily cost", factory: () => studioDaily("cost"), rows: studioDailyRows as Row[] },
        {
            name: "studio breakdown cost",
            factory: () => studioBreakdown("cost"),
            rows: (breakdownRows as Row[]).filter((row) => row["[Breakdown]"] === "Model"),
        },
        { name: "foundry daily cost", factory: () => foundryDaily(), rows: foundryDailyRows as Row[] },
        { name: "foundry cost by model", factory: () => foundryByModel(), rows: modelRows as Row[] },
    ];

    // A tenant that has barely spent: whole-number labels used to print every tick as 0.
    it.each(charts)("$name labels each tick differently when the spend is a fraction of a cent", async ({ factory, rows }) => {
        const { vegaLiteSpec, columnMetadata } = factory();
        const labels = await valueAxisLabels(vegaLiteSpec, scaleCosts(rows, 0.0001), columnMetadata);
        expect(labels.length).toBeGreaterThan(1);
        expect(new Set(labels).size).toBe(labels.length);
    });

    it.each(charts)("$name keeps whole-number labels for ordinary spend", async ({ factory, rows }) => {
        const { vegaLiteSpec, columnMetadata } = factory();
        const labels = await valueAxisLabels(vegaLiteSpec, scaleCosts(rows, 100), columnMetadata);
        expect(labels.length).toBeGreaterThan(1);
        expect(labels.every((label) => !label.includes("."))).toBe(true);
    });
});
