//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { VegaVisual } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { DEFAULT_ORG_ATTRIBUTE, withOrgAttribute } from "@/lib/org-attribute";
import { readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    applyTrendHeatmapTheme,
    TREND_HEATMAP_ORGANIZATION_FIELD,
    trendHeatmap,
    trendHeatmapHeadline,
    trendHeatmapMetrics,
    type TrendHeatmapMetric,
} from "@/queries/adoption";

function distinctValueCount(table: DataTable | undefined, columnName: string): number {
    if (!table) return 0;
    const index = table.columns.findIndex((column) => column.name === columnName);
    if (index === -1) return 0;
    return new Set(table.rows.map((row) => row[index]).filter((value) => value !== null && value !== undefined)).size;
}

/**
 * Where adoption is concentrating or fading, week by week.
 *
 * The report kept this as a separate page because the metric switch is a
 * disconnected model table. Here the heatmap values travel together while the
 * headline still comes from that model toggle.
 */
export function TrendHeatmapStage() {
    const [metric, setMetric] = useState<TrendHeatmapMetric>("activeUsers");
    const { theme } = useThemeContext();
    const org = useOrgAttribute();

    const heatmap = useMemo(() => withOrgAttribute(trendHeatmap({ metric }), org), [metric, org]);
    const heatmapResult = useFilteredQuery({ connection: heatmap.connection, query: heatmap.query });
    const headline = useMemo(() => trendHeatmapHeadline(), []);
    const headlineResult = useFilteredQuery({ connection: headline.connection, query: headline.query });

    const heatmapTable = useMemo(
        () =>
            heatmapResult.data?.status === "success"
                ? toDataTable(heatmapResult.data.table, heatmap.columnMetadata)
                : undefined,
        [heatmapResult.data, heatmap.columnMetadata],
    );

    const headlineRow = useMemo(
        () => (headlineResult.data?.status === "success" ? toSummaryRow(headlineResult.data.table) : undefined),
        [headlineResult.data],
    );

    const selected = trendHeatmapMetrics.find((entry) => entry.id === metric) ?? trendHeatmapMetrics[0];
    const chartHeight = Math.max(240, distinctValueCount(heatmapTable, TREND_HEATMAP_ORGANIZATION_FIELD) * 36 + 80);
    const themedSpec = useMemo(
        () =>
            applyTrendHeatmapTheme(heatmap.vegaLiteSpec, {
                quiet: theme.backgroundHover || theme.backgroundSecondary,
                strong: theme.brandBackground,
                quietText: theme.foreground,
                strongText: theme.brandForeground,
            }),
        [heatmap.vegaLiteSpec, theme],
    );
    // The model writes this headline about organizations, whatever the Group by says.
    const headlineText = org.column === DEFAULT_ORG_ATTRIBUTE ? readText(headlineRow, selected.headlineColumn) : undefined;

    const error =
        heatmapResult.data?.status === "error"
            ? { message: heatmapResult.data.error.message, retry: heatmapResult.refetch }
            : headlineResult.data?.status === "error"
              ? { message: headlineResult.data.error.message, retry: headlineResult.refetch }
              : undefined;
    const isLoading =
        heatmapResult.isLoading ||
        headlineResult.isLoading ||
        !heatmapResult.data ||
        !headlineResult.data ||
        !heatmapTable;

    return (
        <Section
            id={stageAnchor("trend-heatmap")}
            title="Trend heatmap"
            description="Where and when use is concentrating or fading, week by week."
            actions={
                <SegmentedControl
                    label="Heatmap metric"
                    options={trendHeatmapMetrics}
                    value={metric}
                    onChange={setMetric}
                    className="flex-wrap"
                />
            }
        >
            <div style={{ height: chartHeight }}>
                {error ? (
                    <QueryError className="h-full" message={error.message} onRetry={error.retry} />
                ) : isLoading ? (
                    <QueryLoading className="h-full" />
                ) : heatmapTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No weekly history"
                        description="There are no dated interactions in the current selection, so there are no weeks to plot."
                    />
                ) : (
                    <div className="flex h-full flex-col gap-300">
                        {headlineText && (
                            <p className="text-[length:var(--text-300)] leading-300 text-muted-foreground">
                                {headlineText}
                            </p>
                        )}
                        <div className="min-h-0 flex-1">
                            <VegaVisual
                                spec={themedSpec}
                                data={heatmapTable}
                                theme={theme}
                                header={{
                                    title: `${selected.label} by ${org.noun} and week`,
                                    subtitle: "Darker cells mark the strongest concentration in the current selection",
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>
        </Section>
    );
}
