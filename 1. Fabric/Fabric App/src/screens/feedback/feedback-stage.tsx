//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual, type VisualizationSpec } from "@microsoft/fabric-visuals";
import { stageAnchor } from "@/components/destinations";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useOutcomeColors, type OutcomeColors } from "@/hooks/use-palette-theme";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import { withoutEmoji } from "@/lib/model-text";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    FEEDBACK_ON_CALENDAR,
    FEEDBACK_SURFACE_MIN_COUNT,
    feedbackCategory,
    feedbackComments,
    feedbackSummary,
    feedbackSurface,
    feedbackTrend,
} from "@/queries/feedback";

const dateFormatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Every feedback query counts the same rows: those dated on the Calendar. */
const ON_CALENDAR = { extra: [FEEDBACK_ON_CALENDAR] } as const;

/** Automatic segment labels would print thumbs down as negative counts. */
const NO_STACK_LABELS = { disableStackedDataLabels: true };

function formatSubmitted(value: unknown): string {
    if (typeof value !== "string") return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function commentColumns(colors: FeedbackColorRange | undefined): GridColumnDef[] {
    return [
        { id: "Date Submitted", header: "Date", width: 124, cellRenderer: (value) => formatSubmitted(value) },
        {
            id: "Feedback Type",
            header: "Signal",
            width: 148,
            cellRenderer: (value) => {
                const label = typeof value === "string" ? value : "";
                const color = colors ? (label === "Thumbs Down" ? colors[1] : colors[0]) : undefined;
                return (
                    <span className="inline-flex items-center gap-200">
                        {color && <span className="size-200 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
                        <span>{label}</span>
                    </span>
                );
            },
        },
        { id: "Category", header: "Category", minWidth: 160 },
        { id: "Surface / Agent", header: "Surface or agent", minWidth: 180 },
        { id: "Comment", header: "Comment", minWidth: 360 },
    ];
}

interface ThemeWithCategoricalPalette {
    categoricalPalette?: readonly string[];
}

type FeedbackColorRange = readonly [string, string];

interface MutableFeedbackSpec {
    encoding?: {
        color?: {
            scale?: {
                domain?: string[];
                range?: string[];
            };
        };
    };
}

function feedbackColorRange(
    outcomeColors: OutcomeColors | undefined,
    theme: ThemeWithCategoricalPalette,
): FeedbackColorRange | undefined {
    if (outcomeColors) return [outcomeColors.positive, outcomeColors.negative];

    const [positive, negative] = theme.categoricalPalette ?? [];
    if (!positive || !negative) return undefined;
    return [positive, negative];
}

function withFeedbackColors(spec: VisualizationSpec, range: FeedbackColorRange | undefined): VisualizationSpec {
    if (!range) return spec;

    const next = structuredClone(spec) as MutableFeedbackSpec;
    if (!next.encoding?.color) return next as VisualizationSpec;

    next.encoding.color.scale = {
        ...(next.encoding.color.scale ?? {}),
        domain: ["Thumbs Up", "Thumbs Down"],
        range: [...range],
    };
    return next as VisualizationSpec;
}

function uniqueValues(table: { columns: readonly { name: string }[]; rows: readonly unknown[][] }, columnName: string): number {
    const index = table.columns.findIndex((column) => column.name === columnName);
    if (index < 0) return table.rows.length;
    return new Set(table.rows.map((row) => row[index])).size;
}

/**
 * What people tell Copilot and agents through product feedback.
 *
 * The Power BI page treats feedback as another report tab; the app makes it a
 * date-only destination because ProductFeedback relates to Calendar but not to
 * organization, license or audience data.
 */
export function FeedbackStage() {
    const { theme } = useThemeContext();
    const outcomeColors = useOutcomeColors();

    const summary = useFilteredQuery(feedbackSummary(), ON_CALENDAR);
    const trend = feedbackTrend();
    const trendResult = useFilteredQuery({ connection: trend.connection, query: trend.query }, ON_CALENDAR);
    const category = feedbackCategory();
    const categoryResult = useFilteredQuery({ connection: category.connection, query: category.query }, ON_CALENDAR);
    const surface = feedbackSurface();
    const surfaceResult = useFilteredQuery({ connection: surface.connection, query: surface.query }, ON_CALENDAR);
    const comments = feedbackComments();
    const commentsResult = useFilteredQuery({ connection: comments.connection, query: comments.query }, ON_CALENDAR);

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );
    const trendTable = useMemo(
        () =>
            trendResult.data?.status === "success"
                ? toDataTable(trendResult.data.table, trend.columnMetadata)
                : undefined,
        [trendResult.data, trend.columnMetadata],
    );
    const categoryTable = useMemo(
        () =>
            categoryResult.data?.status === "success"
                ? toDataTable(categoryResult.data.table, category.columnMetadata)
                : undefined,
        [categoryResult.data, category.columnMetadata],
    );
    const surfaceTable = useMemo(
        () =>
            surfaceResult.data?.status === "success"
                ? toDataTable(surfaceResult.data.table, surface.columnMetadata)
                : undefined,
        [surfaceResult.data, surface.columnMetadata],
    );
    const commentsTable = useMemo(
        () =>
            commentsResult.data?.status === "success"
                ? toDataTable(commentsResult.data.table, comments.columnMetadata)
                : undefined,
        [commentsResult.data, comments.columnMetadata],
    );

    const colorRange = useMemo(
        () => feedbackColorRange(outcomeColors, theme as ThemeWithCategoricalPalette),
        [outcomeColors, theme],
    );
    const trendSpec = useMemo(() => withFeedbackColors(trend.vegaLiteSpec, colorRange), [trend.vegaLiteSpec, colorRange]);
    const categorySpec = useMemo(
        () => withFeedbackColors(category.vegaLiteSpec, colorRange),
        [category.vegaLiteSpec, colorRange],
    );
    const columns = useMemo(() => commentColumns(colorRange), [colorRange]);

    const rawThemeSummary = readText(summaryRow, "[Theme Summary]");
    const themeSummary = rawThemeSummary ? withoutEmoji(rawThemeSummary) : undefined;

    return (
        <Section
            id={stageAnchor("feedback")}
            title="Feedback"
            description="What people say after Copilot or an agent helps, misses, or gets in the way."
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No feedback data"
                    description="The semantic model returned no rows. Check that product feedback has been loaded."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <KpiCard
                        label="Satisfaction"
                        value={readNumber(summaryRow, "[Satisfaction]")}
                        format="percent"
                        emphasis
                    />
                    <KpiCard label="Total feedback" value={readNumber(summaryRow, "[Total Feedback]")} />
                    <KpiCard label="Thumbs up" value={readNumber(summaryRow, "[Thumbs Up]")} />
                    <KpiCard label="Thumbs down" value={readNumber(summaryRow, "[Thumbs Down]")} />
                </div>
            )}

            {themeSummary && (
                <p className="max-w-[85ch] rounded-xl border border-border bg-card p-400 text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    {themeSummary}
                </p>
            )}

            <div className="grid gap-400 xl:grid-cols-2">
                <div
                    className="h-[360px]"
                    style={
                        categoryTable
                            ? {
                                  height: rowChartHeight(uniqueValues(categoryTable, "Category"), {
                                      perRow: 40,
                                      chrome: 116,
                                  }),
                              }
                            : undefined
                    }
                >
                    {trendResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={trendResult.data.error.message}
                            onRetry={trendResult.refetch}
                        />
                    ) : trendResult.isLoading || !trendTable ? (
                        <QueryLoading className="h-full" />
                    ) : trendTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No feedback trend"
                            description="No feedback was submitted in the selected date range."
                        />
                    ) : (
                        <VegaVisual
                            spec={trendSpec}
                            data={trendTable}
                            theme={theme}
                            capabilities={NO_STACK_LABELS}
                            header={{
                                title: "Weekly feedback sentiment",
                                subtitle: "Thumbs up above zero; thumbs down below.",
                            }}
                        />
                    )}
                </div>

                <div className="h-[360px]">
                    {categoryResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={categoryResult.data.error.message}
                            onRetry={categoryResult.refetch}
                        />
                    ) : categoryResult.isLoading || !categoryTable ? (
                        <QueryLoading className="h-full" />
                    ) : categoryTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No topics to compare"
                            description="Only testing or uncategorized feedback was submitted in this period."
                        />
                    ) : (
                        <VegaVisual
                            spec={categorySpec}
                            data={categoryTable}
                            theme={theme}
                            header={{
                                title: "What it's about",
                                subtitle: "Testing and uncategorized rows are excluded to match the report.",
                            }}
                        />
                    )}
                </div>
            </div>

            <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                Surfaces and agents with fewer than {formatKpi(FEEDBACK_SURFACE_MIN_COUNT, "whole")} feedback
                items are left out of the satisfaction comparison so one or two comments do not set the rank.
            </p>

            <div className="grid gap-400">
                <div
                    className="h-[420px]"
                    style={
                        surfaceTable
                            ? { height: rowChartHeight(surfaceTable.rows.length, { perRow: 40, chrome: 116 }) }
                            : undefined
                    }
                >
                    {surfaceResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={surfaceResult.data.error.message}
                            onRetry={surfaceResult.refetch}
                        />
                    ) : surfaceResult.isLoading || !surfaceTable ? (
                        <QueryLoading className="h-full" />
                    ) : surfaceTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No surface has enough feedback"
                            description="No surface or agent reached the minimum sample size for a fair satisfaction comparison."
                        />
                    ) : (
                        <VegaVisual
                            spec={surface.vegaLiteSpec}
                            data={surfaceTable}
                            theme={theme}
                            header={{
                                title: "Satisfaction by surface or agent",
                                subtitle: "Ranked by satisfaction, with feedback count in the tooltip.",
                            }}
                        />
                    )}
                </div>

                <div className="flex h-[560px] flex-col">
                    {commentsResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={commentsResult.data.error.message}
                            onRetry={commentsResult.refetch}
                        />
                    ) : commentsResult.isLoading || !commentsTable ? (
                        <QueryLoading className="h-full" />
                    ) : commentsTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No written comments"
                            description="The selected feedback has thumbs up and down, but no non-empty comments."
                        />
                    ) : (
                        <DataGrid
                            columns={columns}
                            data={commentsTable}
                            defaultSort={[{ columnId: "Date Submitted", direction: "desc" }]}
                            theme={theme}
                            header={{
                                title: "Recent comments",
                                subtitle: `${formatKpi(commentsTable.rows.length, "whole")} latest non-empty comments`,
                            }}
                        />
                    )}
                </div>
            </div>
        </Section>
    );
}
