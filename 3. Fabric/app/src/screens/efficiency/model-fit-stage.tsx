//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual, type VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable, VisualTheme } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useOutcomeColors, type OutcomeColors } from "@/hooks/use-palette-theme";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import type { FilterKey } from "@/lib/filters";
import type { OrgAttribute } from "@/lib/org-attribute";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    deriveModelFitVerdict,
    modelFitByOrganization,
    modelFitByPerson,
    modelFitByTask,
    modelFitSummary,
    modelMatchByTool,
    modelUsage,
    type ModelFitVerdict,
} from "@/queries/efficiency";

type ModelFitView = "task" | "organization" | "person";

function viewOptions(orgLabel: string): readonly { id: ModelFitView; label: string }[] {
    return [
        { id: "task", label: "Task" },
        { id: "organization", label: orgLabel },
        { id: "person", label: "Person" },
    ];
}

const ACTIVITY_FILTER: FilterKey[] = ["audience"];

const OUTCOME_DOMAIN = ["Well matched", "Over-specified", "Under-specified", "Not judged"] as const;

interface VerdictPalette {
    positive: string;
    negative: string;
    caution: string;
    neutral: string;
}

function fallbackOutcomePalette(theme: VisualTheme): VerdictPalette {
    const palette = theme.categoricalPalette ?? [];
    return {
        positive: palette[0] ?? theme.brandBackground,
        negative: palette[1] ?? theme.foregroundSecondary,
        caution: palette[2] ?? theme.brandForeground,
        neutral: palette[3] ?? theme.stroke,
    };
}

function verdictPalette(outcomeColors: OutcomeColors | undefined, theme: VisualTheme): VerdictPalette {
    return outcomeColors ?? fallbackOutcomePalette(theme);
}

function colorForVerdict(verdict: ModelFitVerdict, palette: VerdictPalette): string {
    switch (verdict) {
        case "Well matched":
            return palette.positive;
        case "Over-specified":
            return palette.negative;
        case "Under-specified":
            return palette.caution;
        case "Not enough data":
            return palette.neutral;
    }
}

function injectOutcomeColors(spec: VisualizationSpec, palette: VerdictPalette): VisualizationSpec {
    const base = spec as Record<string, unknown>;
    const encoding = (base.encoding ?? {}) as Record<string, unknown>;
    const color = (encoding.color ?? {}) as Record<string, unknown>;
    const scale = (color.scale ?? {}) as Record<string, unknown>;

    return {
        ...base,
        encoding: {
            ...encoding,
            color: {
                ...color,
                scale: {
                    ...scale,
                    domain: OUTCOME_DOMAIN,
                    range: [palette.positive, palette.negative, palette.caution, palette.neutral],
                },
            },
        },
    } as unknown as VisualizationSpec;
}

function numericCell(row: readonly unknown[], table: DataTable, columnName: string): number | undefined {
    const index = table.columns.findIndex((column) => column.name === columnName);
    if (index < 0) return undefined;
    const value = row[index];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withVerdicts(table: DataTable): DataTable {
    return {
        columns: [{ name: "Verdict", displayName: "Verdict" }, ...table.columns],
        rows: table.rows.map((row) => [
            deriveModelFitVerdict({
                judgedSessions: numericCell(row, table, "Judged Sessions"),
                overSpecifiedSessions: numericCell(row, table, "Over-specified Sessions"),
                underSpecifiedSessions: numericCell(row, table, "Under-specified Sessions"),
            }),
            ...row,
        ]),
    };
}

function distinctValues(table: DataTable | undefined, columnName: string): number {
    if (!table) return 0;
    const index = table.columns.findIndex((column) => column.name === columnName);
    if (index < 0) return table.rows.length;
    return new Set(table.rows.map((row) => row[index])).size;
}

function hasAnyText(table: DataTable | undefined, columnName: string): boolean {
    if (!table) return false;
    const index = table.columns.findIndex((column) => column.name === columnName);
    return index >= 0 && table.rows.some((row) => typeof row[index] === "string" && row[index].trim() !== "");
}

/** Room for the VegaVisual header, a top legend and the value axis. */
const LEGEND_CHART = { perRow: 44, chrome: 190 };

/** Automatic segment labels misplace shares once segments are reordered; the tooltip carries them. */
const NO_STACK_LABELS = { disableStackedDataLabels: true };

function verdictCell(value: ReactNode, palette: VerdictPalette) {
    const verdict = typeof value === "string" ? (value as ModelFitVerdict) : "Not enough data";
    return (
        <span className="inline-flex items-center gap-200">
            <span className="size-200 rounded-full" style={{ backgroundColor: colorForVerdict(verdict, palette) }} />
            <span>{verdict}</span>
        </span>
    );
}

function verdictQuery(view: ModelFitView, org: OrgAttribute) {
    switch (view) {
        case "organization":
            return modelFitByOrganization(org);
        case "person":
            return modelFitByPerson();
        case "task":
            return modelFitByTask();
    }
}

/**
 * The model-choice stage asks whether the logged model is matched to the work,
 * and keeps coverage visible before showing any verdict as confident.
 */
export function ModelFitStage() {
    const [view, setView] = useState<ModelFitView>("task");
    const { theme } = useThemeContext();
    const org = useOrgAttribute();
    const outcomeColors = useOutcomeColors();
    const palette = useMemo(() => verdictPalette(outcomeColors, theme), [outcomeColors, theme]);

    const summary = useFilteredQuery(modelFitSummary());
    const usage = modelUsage();
    const usageResult = useFilteredQuery({ connection: usage.connection, query: usage.query });
    const match = modelMatchByTool();
    const matchResult = useFilteredQuery({ connection: match.connection, query: match.query }, { ignore: ACTIVITY_FILTER });
    const verdicts = useMemo(() => verdictQuery(view, org), [view, org]);
    const verdictResult = useFilteredQuery({ connection: verdicts.connection, query: verdicts.query });

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );
    const usageTable = useMemo(
        () => (usageResult.data?.status === "success" ? toDataTable(usageResult.data.table, usage.columnMetadata) : undefined),
        [usageResult.data, usage.columnMetadata],
    );
    const matchTable = useMemo(
        () => (matchResult.data?.status === "success" ? toDataTable(matchResult.data.table, match.columnMetadata) : undefined),
        [matchResult.data, match.columnMetadata],
    );
    const verdictTable = useMemo(
        () =>
            verdictResult.data?.status === "success"
                ? withVerdicts(toDataTable(verdictResult.data.table, verdicts.columnMetadata))
                : undefined,
        [verdictResult.data, verdicts.columnMetadata],
    );

    const matchSpec = useMemo(() => injectOutcomeColors(match.vegaLiteSpec, palette), [match.vegaLiteSpec, palette]);
    // The model leaves the reason blank when nothing is over- or under-specified.
    const showReason = hasAnyText(verdictTable, "Main Reason");
    const views = useMemo(() => viewOptions(org.label), [org.label]);
    const segmentLabel = view === "person" ? "Person" : view === "organization" ? org.label : "Task";
    const verdictColumns: GridColumnDef[] = useMemo(
        () => [
            { id: "Verdict", header: "Verdict", minWidth: 176, cellRenderer: (value) => verdictCell(value, palette) },
            { id: "Segment", header: segmentLabel, minWidth: 240 },
            { id: "Main Model", header: "Main model", minWidth: 180 },
            ...(showReason ? [{ id: "Main Reason", header: "Main reason", minWidth: 180 }] : []),
            { id: "Sessions", header: "Sessions", width: 112, numericStyling: true },
            { id: "Judged Share", header: "Judged share", width: 132, numericStyling: true },
        ],
        [palette, segmentLabel, showReason],
    );

    const notice = readText(summaryRow, "[Coverage Notice]");

    return (
        <Section
            id={stageAnchor("model-fit")}
            title="Model fit"
            description="Whether the model doing the work is well matched, too expensive for the task, or not strong enough for the job."
            actions={<SegmentedControl label="Model fit view" options={views} value={view} onChange={setView} />}
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-5">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No model fit data"
                    description="The semantic model returned no rows. Check that the model has been refreshed since the last data load."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-5">
                    <KpiCard label="Sessions" value={readNumber(summaryRow, "[Sessions]")} emphasis />
                    <KpiCard label="Logged share" value={readNumber(summaryRow, "[Logged Share]")} format="percent" />
                    <KpiCard label="Well-matched share" value={readNumber(summaryRow, "[Well-matched Share]")} format="percent" />
                    <KpiCard label="Over-specified share" value={readNumber(summaryRow, "[Over-specified Share]")} format="percent" />
                    <KpiCard label="Under-specified share" value={readNumber(summaryRow, "[Under-specified Share]")} format="percent" />
                </div>
            )}

            <div className="grid gap-500 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div
                    className="h-[340px]"
                    style={usageTable ? { height: rowChartHeight(usageTable.rows.length, LEGEND_CHART) } : undefined}
                >
                    {usageResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={usageResult.data.error.message}
                            onRetry={usageResult.refetch}
                        />
                    ) : usageResult.isLoading || !usageTable ? (
                        <QueryLoading className="h-full" />
                    ) : usageTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No model names logged"
                            description="No sessions in this selection carry a model name yet."
                        />
                    ) : (
                        <VegaVisual
                            spec={usage.vegaLiteSpec}
                            data={usageTable}
                            theme={theme}
                            header={{ title: "Model usage", subtitle: "Sessions by logged model and cost tier" }}
                        />
                    )}
                </div>

                <div className="flex flex-col gap-200">
                    <FilterNote
                        ignored={ACTIVITY_FILTER}
                        reason="this chart already splits sessions by Copilot and Agents."
                    />
                    <div
                        className="h-[340px]"
                        style={matchTable ? { height: rowChartHeight(distinctValues(matchTable, "Activity"), LEGEND_CHART) } : undefined}
                    >
                        {matchResult.data?.status === "error" ? (
                            <QueryError
                                className="h-full"
                                message={matchResult.data.error.message}
                                onRetry={matchResult.refetch}
                            />
                        ) : matchResult.isLoading || !matchTable ? (
                            <QueryLoading className="h-full" />
                        ) : matchTable.rows.length === 0 ? (
                            <QueryEmpty
                                className="h-full"
                                title="No sessions to split"
                                description="There is no Copilot or agent activity in this selection."
                            />
                        ) : (
                            <VegaVisual
                                spec={matchSpec}
                                data={matchTable}
                                theme={theme}
                                capabilities={NO_STACK_LABELS}
                                header={{ title: "Match by tool", subtitle: "Well matched, exceptions and unjudged sessions" }}
                            />
                        )}
                    </div>
                </div>
            </div>

            <div
                className="flex h-[560px] flex-col"
                style={verdictTable && verdictTable.rows.length > 0 ? { height: gridHeight(verdictTable.rows.length) } : undefined}
            >
                {verdictResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={verdictResult.data.error.message}
                        onRetry={verdictResult.refetch}
                    />
                ) : verdictResult.isLoading || !verdictTable ? (
                    <QueryLoading className="h-full" />
                ) : verdictTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No segments to judge"
                        description="No sessions in this selection have enough model and task detail to build the table."
                    />
                ) : (
                    <DataGrid
                        columns={verdictColumns}
                        data={verdictTable}
                        defaultSort={[{ columnId: "Sessions", direction: "desc" }]}
                        theme={theme}
                        header={{
                            title: `Verdicts by ${view === "organization" ? org.noun : segmentLabel.toLowerCase()}`,
                            subtitle: "Top segments by sessions, with a verdict only after five judged sessions",
                        }}
                    />
                )}
            </div>

            {notice && <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">{notice}</p>}
        </Section>
    );
}
