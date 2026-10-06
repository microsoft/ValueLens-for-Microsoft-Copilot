//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@/components/vega-visual";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { GradeMark } from "@/components/grade-mark";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { outcomePalette, withColorScale } from "@/lib/color-scale";
import type { FilterKey } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { MODEL_VERDICTS } from "@/lib/grading-method";
import { heatRenderer, type HeatDomain } from "@/lib/heat";
import type { OrgAttribute } from "@/lib/org-attribute";
import { readNumber, readText, toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    deriveModelFitVerdict,
    modelFitByOrganization,
    modelFitByPerson,
    modelFitByTask,
    modelFitSummary,
    modelMatchByTool,
    modelUsage,
} from "@/queries/efficiency";

type ModelFitView = "task" | "organization" | "person";

/** The report's Model Fit View buttons, with the middle one following the Group by choice. */
function viewOptions(orgLabel: string): readonly { id: ModelFitView; label: string }[] {
    return [
        { id: "task", label: "Task" },
        { id: "organization", label: orgLabel },
        { id: "person", label: "User" },
    ];
}

const ACTIVITY_FILTER: FilterKey[] = ["audience"];

const OUTCOME_DOMAIN = ["Good match", "Lighter model may do", "Try stronger", "Not judged"] as const;

/** Shares of judged sessions, so every view shades on the same absolute scale. */
const SHARE_HEAT: HeatDomain = { min: 0, max: 1 };

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

function verdictCell(value: ReactNode) {
    const verdict = MODEL_VERDICTS.find((rule) => rule.name === value) ?? MODEL_VERDICTS[MODEL_VERDICTS.length - 1];
    return (
        <span className="inline-flex items-center gap-200">
            <GradeMark tone={verdict.tone} icon={verdict.icon} />
            <span>{verdict.name}</span>
        </span>
    );
}

/** A blank exception share on a judged segment is a true 0%, as the report's blank cell means. */
function shareOfJudged(value: unknown, row: Row): string | null {
    if (typeof value === "number") return formatKpi(value, "percent");
    const judged = row["Judged Sessions"];
    return typeof judged === "number" && judged > 0 ? formatKpi(0, "percent") : null;
}

/**
 * The three verdict shares divide by judged sessions, so once any of them has a
 * value the others are zero rather than unknown.
 */
function judgedShares(row: SummaryRow | undefined) {
    const well = readNumber(row, "[Well-matched Share]");
    const over = readNumber(row, "[Over-specified Share]");
    const under = readNumber(row, "[Under-specified Share]");
    const judged = well !== undefined || over !== undefined || under !== undefined;
    const orZero = (value: number | undefined) => value ?? (judged ? 0 : undefined);
    return { well: orZero(well), over: orZero(over), under: orZero(under) };
}

function shareColumn(id: string, header: string, width: number, color?: string): GridColumnDef {
    return {
        id,
        header,
        width,
        numericStyling: true,
        cellRenderer: color
            ? heatRenderer({ domain: SHARE_HEAT, format: shareOfJudged, color })
            : (value, row) => shareOfJudged(value, row),
    };
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
    const palette = useMemo(() => outcomePalette(outcomeColors, theme), [outcomeColors, theme]);

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

    const matchSpec = useMemo(
        () =>
            withColorScale(match.vegaLiteSpec, OUTCOME_DOMAIN, [
                palette.positive,
                palette.negative,
                palette.caution,
                palette.neutral,
            ]),
        [match.vegaLiteSpec, palette],
    );
    // The model leaves the reason blank when nothing is over- or under-specified.
    const showReason = hasAnyText(verdictTable, "Main Reason");
    const views = useMemo(() => viewOptions(org.label), [org.label]);
    const segmentLabel = view === "person" ? "User" : view === "organization" ? org.label : "Task";
    // Mirrors the report's mm_table: verdict, main model and reason, then judged coverage and the three shares.
    const verdictColumns: GridColumnDef[] = useMemo(
        () => [
            { id: "Verdict", header: "Verdict", width: 196, cellRenderer: (value) => verdictCell(value) },
            // A fixed width keeps the name visible; the grid scrolls sideways on narrow screens.
            { id: "Segment", header: segmentLabel, width: 232 },
            { id: "Main Model", header: "Main model", width: 176 },
            ...(showReason ? [{ id: "Main Reason", header: "Main reason", width: 184 }] : []),
            { id: "Sessions", header: "Sessions", width: 100, numericStyling: true },
            shareColumn("Judged Share", "Judged", 92),
            shareColumn("Well-matched Share", "Good match", 116),
            shareColumn("Over-specified Share", "Lighter model may do", 168, palette.negative),
            shareColumn("Under-specified Share", "Try stronger", 124, palette.caution),
            { id: "Judged Sessions", header: "Judged sessions", hidden: true },
        ],
        [palette, segmentLabel, showReason],
    );

    const notice = readText(summaryRow, "[Coverage Notice]");
    const shares = judgedShares(summaryRow);

    return (
        <Section
            id={stageAnchor("model-fit")}
            title="Model fit"
            description="Whether the model doing the work suits it: a good match, a premium model on light work, or a mid-cost model on heavy work."
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
                    <KpiCard
                        label="Model logged"
                        value={readNumber(summaryRow, "[Logged Share]")}
                        format="percent"
                        detail="Share of sessions"
                    />
                    <KpiCard
                        label="Good match"
                        value={shares.well}
                        format="percent"
                        detail="Model cost suits the work"
                    />
                    <KpiCard
                        label="Lighter model may do"
                        value={shares.over}
                        format="percent"
                        detail="Premium model on light work"
                    />
                    <KpiCard
                        label="Try stronger"
                        value={shares.under}
                        format="percent"
                        detail="Mid-cost model on Strong-fit work"
                    />
                </div>
            )}

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
                                header={{ title: "Match by tool", subtitle: "Good matches, the two exceptions, and unjudged sessions" }}
                            />
                        )}
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-300">
                <div className="flex flex-wrap items-center gap-300">
                    <span
                        aria-hidden="true"
                        className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground"
                    >
                        View verdicts by
                    </span>
                    <SegmentedControl label="View verdicts by" options={views} value={view} onChange={setView} />
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
                            key={view}
                            columns={verdictColumns}
                            data={verdictTable}
                            defaultSort={[{ columnId: "Sessions", direction: "desc" }]}
                            theme={theme}
                            header={{
                                title: `Verdicts by ${view === "organization" ? org.noun : segmentLabel.toLowerCase()}`,
                                subtitle: "Top 25 by sessions. Shares are of judged sessions; a verdict needs five judged sessions.",
                            }}
                        />
                    )}
                </div>
            </div>

            {notice && <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">{notice}</p>}
        </Section>
    );
}
