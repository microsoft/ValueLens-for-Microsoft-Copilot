//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { contrastingTextColor } from "@/lib/color-scale";
import { connection, FORMAT_HOURS, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./trend-heatmap.dax?raw";
import spec from "./trend-heatmap.json";

export const TREND_HEATMAP_ORGANIZATION_FIELD = "Chat + Agent Org DataOrganization";
export const TREND_HEATMAP_WEEK_FIELD = "Chat + Agent Interactions (Audit Logs)WeekStart";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": {
        name: TREND_HEATMAP_ORGANIZATION_FIELD,
        displayName: "Organization",
    },
    "Chat + Agent Interactions (Audit Logs)[WeekStart]": {
        name: TREND_HEATMAP_WEEK_FIELD,
        displayName: "Week starting",
        format: "dd mmm yyyy",
    },
    "[Active Users]": { name: "Active Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Active Days Per User]": {
        name: "Active Days Per User",
        displayName: "Active days per user",
        format: FORMAT_RATE,
    },
    "[Expert Hours Per User]": {
        name: "Expert Hours Per User",
        displayName: "Expert-equivalent hours per user",
        format: FORMAT_HOURS,
    },
    "[Sessions Per User]": {
        name: "Sessions Per User",
        displayName: "Sessions per user",
        format: FORMAT_RATE,
    },
};

/** The report's disconnected heatmap toggle, reduced to the four useful metrics. */
export type TrendHeatmapMetric = "activeUsers" | "activeDays" | "expertHours" | "sessions";

export const trendHeatmapMetrics: readonly {
    id: TrendHeatmapMetric;
    label: string;
    order: 0 | 1 | 3 | 4;
    field: string;
    title: string;
    format: string;
    headlineColumn: string;
}[] = [
    {
        id: "activeUsers",
        label: "Active users",
        order: 0,
        field: "Active Users",
        title: "Active users",
        format: ",.0f",
        headlineColumn: "[Active Users Headline]",
    },
    {
        id: "activeDays",
        label: "Active days per user",
        order: 1,
        field: "Active Days Per User",
        title: "Active days per user",
        format: ",.1f",
        headlineColumn: "[Active Days Headline]",
    },
    {
        id: "expertHours",
        label: "Expert-equivalent hours per user",
        order: 3,
        field: "Expert Hours Per User",
        title: "Expert-equivalent hours per user",
        format: ",.1f",
        headlineColumn: "[Expert Hours Headline]",
    },
    {
        id: "sessions",
        label: "Sessions per user",
        order: 4,
        field: "Sessions Per User",
        title: "Sessions per user",
        format: ",.1f",
        headlineColumn: "[Sessions Headline]",
    },
] as const;

const metricsById = Object.fromEntries(
    trendHeatmapMetrics.map((metric) => [metric.id, metric]),
) as Record<TrendHeatmapMetric, (typeof trendHeatmapMetrics)[number]>;

interface TrendHeatmapParams {
    /** Which disconnected heatmap toggle metric to render. Defaults to active users. */
    metric?: TrendHeatmapMetric;
}

interface TrendHeatmapThemeParams {
    /** Quiet endpoint from the host theme, usually the current hover surface. */
    quiet: string;
    /** Strong endpoint from the host theme, scoped to the current destination palette. */
    strong: string;
    /** One label colour, usually the page text. */
    quietText: string;
    /** The other label colour, usually the page background. Each cell takes whichever reads better on it. */
    strongText: string;
}

/**
 * Organization-by-week concentration map. The query returns every heatmap
 * metric once; the factory only swaps the Vega binding, so the toggle is instant.
 */
export function trendHeatmap(params?: TrendHeatmapParams) {
    const metric = metricsById[params?.metric ?? "activeUsers"];
    const vegaLiteSpec = JSON.parse(
        JSON.stringify(spec)
            .replaceAll("__ORG__", TREND_HEATMAP_ORGANIZATION_FIELD)
            .replaceAll("__WEEK__", TREND_HEATMAP_WEEK_FIELD)
            .replaceAll("__VALUE__", metric.field)
            .replaceAll("__TITLE__", metric.title)
            .replaceAll("__FORMAT__", metric.format),
    ) as VisualizationSpec;

    return { connection, query, columnMetadata, vegaLiteSpec };
}

/**
 * Injects the destination palette after the app theme has been read from CSS,
 * keeping the reusable JSON free of committed colours.
 */
export function applyTrendHeatmapTheme(
    baseSpec: VisualizationSpec,
    colors: TrendHeatmapThemeParams,
): VisualizationSpec {
    const themed = structuredClone(baseSpec) as unknown as MutableHeatmapSpec;
    const cellColor = themed.layer[0].encoding.color;
    cellColor.scale = { ...(cellColor.scale ?? {}), range: [colors.quiet, colors.strong] };
    themed.layer[1].encoding.color = contrastingTextColor(cellColor.field, colors.quietText, colors.strongText);
    return themed as unknown as VisualizationSpec;
}

interface MutableHeatmapSpec {
    layer: [
        { encoding: { color: { field: string; scale?: Record<string, unknown> } } },
        { encoding: { color?: unknown } },
    ];
}
