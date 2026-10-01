//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { ChoiceMenu } from "@/components/choice-menu";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { ChartPanel, KpiRowState, NoteCard, Panel } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { useSummaryQuery, useTableQuery } from "@/hooks/use-table-query";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { outcomePalette, withColorScale } from "@/lib/color-scale";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { plainText } from "@/lib/model-text";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import { formatCell, totalsRow, TREE_GRID } from "@/lib/tree-grid";
import {
    GROUP_BY_COLUMNS,
    groupByChoices,
    OUTCOMES,
    performanceByGroup,
    performanceErrors,
    performanceSummary,
    performanceWeekly,
    readableErrors,
    readableGroups,
    type EvaluationOptions,
} from "@/queries/agent-evaluation";
import { ModelRead } from "./model-read";

const SUMMARY = performanceSummary();
const WEEKLY = performanceWeekly();
const ERRORS = performanceErrors();

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-5";
const NO_STACK_LABELS = { disableStackedDataLabels: true };
const ERROR_CAUSES = ["System fault", "User fault"];

interface GroupColumn {
    id: string;
    header: string;
    width: number;
    format: (value: unknown) => string | null;
    heat?: "volume" | "bad";
}

const percent = formatCell("percent");
const decimal = formatCell("decimal");
const seconds = (value: unknown) => {
    const text = decimal(value);
    return text === null ? null : `${text}s`;
};

/** The by-group table's figures; each id is both its column there and its measure in the summary. */
const GROUP_COLUMNS: readonly GroupColumn[] = [
    { id: "Conversations", header: "Conversations", width: 112, format: formatCell("whole"), heat: "volume" },
    { id: "People", header: "People", width: 80, format: formatCell("whole") },
    { id: "Resolution Rate", header: "Resolved", width: 92, format: percent },
    { id: "True Failure Rate", header: "Failed", width: 84, format: percent, heat: "bad" },
    { id: "Unintended Escalation Rate", header: "Escalated after an error", width: 176, format: percent },
    { id: "Abandonment Rate", header: "Abandoned", width: 100, format: percent },
    { id: "CSAT", header: "Satisfaction", width: 104, format: percent },
    { id: "Error Rate", header: "Hit an error", width: 100, format: percent },
    { id: "Median Response", header: "Median reply", width: 112, format: seconds },
];

function groupColumns(table: DataTable | undefined, groupHeader: string, badColor: string): GridColumnDef[] {
    return [
        { id: "Group", header: groupHeader, width: 180 },
        ...GROUP_COLUMNS.map(
            (column): GridColumnDef => ({
                id: column.id,
                header: column.header,
                width: column.width,
                numericStyling: true,
                cellRenderer: column.heat
                    ? heatRenderer({
                          domain: columnHeat(table, column.id),
                          format: column.format,
                          color: column.heat === "bad" ? badColor : undefined,
                      })
                    : column.format,
            }),
        ),
    ];
}

/** The page summary as the by-group table's last row, so every group reads against the whole. */
function groupTotal(row: SummaryRow | undefined): DataTable | undefined {
    if (!row) return undefined;
    const total: Row = { Group: "All conversations" };
    for (const column of GROUP_COLUMNS) total[column.id] = readNumber(row, `[${column.id}]`);
    return totalsRow(total, [{ id: "Group" }, ...GROUP_COLUMNS]);
}

interface PerformanceStageProps {
    options: EvaluationOptions | undefined;
    extra: readonly string[];
}

/**
 * The report's At a Glance and performance pages: how many conversations
 * agents had, how they ended week by week, and the same rates for each
 * agent, department or topic.
 */
export function PerformanceStage({ options, extra }: PerformanceStageProps) {
    const { theme } = useThemeContext();
    const outcomeColors = useOutcomeColors();
    const palette = useMemo(() => outcomePalette(outcomeColors, theme), [outcomeColors, theme]);

    const choices = useMemo(() => groupByChoices(options?.groupCounts ?? {}), [options?.groupCounts]);
    const [groupId, setGroupId] = useState<string>();
    const group = choices.find((choice) => choice.id === groupId) ?? choices[0] ?? GROUP_BY_COLUMNS[0];
    const byGroupSource = useMemo(() => performanceByGroup(group), [group]);

    const summary = useSummaryQuery(SUMMARY, extra);
    const weekly = useTableQuery(WEEKLY, extra);
    const byGroup = useTableQuery(byGroupSource, extra);
    const errors = useTableQuery(ERRORS, extra);
    const row = summary.row;

    const groupTable = useMemo(() => (byGroup.table ? readableGroups(byGroup.table, group) : undefined), [byGroup.table, group]);
    const errorsTable = useMemo(() => (errors.table ? readableErrors(errors.table) : undefined), [errors.table]);

    const weeklySpec = useMemo(
        () => withColorScale(WEEKLY.vegaLiteSpec, OUTCOMES, [palette.positive, palette.neutral, palette.caution, palette.negative]),
        [palette],
    );
    const errorsSpec = useMemo(
        () => withColorScale(ERRORS.vegaLiteSpec, ERROR_CAUSES, [palette.negative, palette.neutral]),
        [palette],
    );
    const columns = useMemo(() => groupColumns(groupTable, group.label, palette.negative), [groupTable, group.label, palette.negative]);
    const total = useMemo(() => ((groupTable?.rows.length ?? 0) > 1 ? groupTotal(row) : undefined), [groupTable, row]);
    const groupRows = (groupTable?.rows.length ?? 0) + (total ? 1 : 0);

    return (
        <Section
            id={stageAnchor("agent-performance")}
            title="Performance"
            description="How many conversations agents had, how they ended, and what people thought of them."
            actions={
                choices.length > 1 && (
                    <ChoiceMenu
                        label="Group by"
                        allLabel={choices[0].label}
                        choices={choices.slice(1).map((choice) => ({ value: choice.id, label: choice.label }))}
                        value={group.id === choices[0].id ? undefined : group.id}
                        onChange={setGroupId}
                    />
                )
            }
        >
            <KpiRowState
                summary={summary}
                count={5}
                className={KPI_GRID}
                emptyTitle="No agent conversations"
                emptyDescription="Agent Evaluator has no conversations for these slicers. Widen the dates, or check that the transcripts have loaded."
            >
                <KpiCard
                    label="Conversations"
                    value={readNumber(row, "[Conversations]")}
                    emphasis
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="People" value={readNumber(row, "[People]")} />
                            <KpiStat label="Per person" value={readNumber(row, "[Conversations Per Person]")} format="rate" />
                        </div>
                    }
                />
                <KpiCard
                    label="Resolved"
                    value={readNumber(row, "[Resolution Rate]")}
                    format="percent"
                    detail={<KpiStat label="Implied success" value={readNumber(row, "[Implied Success]")} format="percent" />}
                />
                <KpiCard
                    label="Failed"
                    value={readNumber(row, "[True Failure Rate]")}
                    format="percent"
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Failing conversations" value={readNumber(row, "[Failing Conversations]")} />
                            <KpiStat label="Hours lost" value={readNumber(row, "[Hours Lost]")} format="hours" />
                        </div>
                    }
                />
                <KpiCard
                    label="Abandoned"
                    value={readNumber(row, "[Abandonment Rate]")}
                    format="percent"
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Escalated after an error" value={readNumber(row, "[Unintended Escalation Rate]")} format="percent" />
                            <KpiStat label="Hit an error" value={readNumber(row, "[Error Rate]")} format="percent" />
                        </div>
                    }
                />
                <KpiCard
                    label="Satisfaction"
                    value={readNumber(row, "[CSAT]")}
                    format="percent"
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Thumbs up" value={readNumber(row, "[Thumbs Up]")} />
                            <KpiStat label="Thumbs down" value={readNumber(row, "[Thumbs Down]")} />
                        </div>
                    }
                />
            </KpiRowState>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={weekly}
                    spec={weeklySpec}
                    capabilities={NO_STACK_LABELS}
                    height={380}
                    title="How conversations ended"
                    subtitle="Conversations each week, by how they ended"
                    emptyTitle="No weekly conversations"
                    emptyDescription="No agent conversations fall in these dates."
                />
                <ModelRead
                    verdicts={[
                        { term: "Performance", text: readText(row, "[Verdict Performance]") },
                        { term: "Quality", text: readText(row, "[Verdict Quality]") },
                        { term: "Adoption", text: readText(row, "[Verdict Adoption]") },
                    ]}
                    focus={[
                        { term: "Weakest agent", text: readText(row, "[Focus Agent]") },
                        { term: "Knowledge", text: readText(row, "[Focus Knowledge]") },
                        { term: "Where people give up", text: readText(row, "[Focus Give Up]") },
                    ]}
                />
            </div>

            <Panel
                result={byGroup}
                table={groupTable}
                height={gridHeight(groupRows, TREE_GRID)}
                emptyTitle="No groups to compare"
                emptyDescription="No conversations in these slicers carry this field."
            >
                {(table) => (
                    <DataGrid
                        key={group.id}
                        columns={columns}
                        data={table}
                        grandTotals={total ? { position: "bottom", data: total } : undefined}
                        theme={theme}
                        header={{ title: `Performance by ${group.label.toLowerCase()}`, subtitle: "The busiest first, with every rate side by side" }}
                    />
                )}
            </Panel>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={errors}
                    table={errorsTable}
                    spec={errorsSpec}
                    height={rowChartHeight(errorsTable?.rows.length ?? 6, { perRow: 36, chrome: 148 })}
                    title="What went wrong"
                    subtitle="The most common errors, and whether the agent or the person hit them"
                    emptyTitle="No errors"
                    emptyDescription="No conversation in these slicers hit an error."
                />
                <div className="self-start">
                    <NoteCard
                        title="Errors and hand-offs"
                        notes={[
                            { term: "Errors", text: plainText(readText(row, "[Error Story]")) },
                            { term: "Escalations", text: plainText(readText(row, "[Escalation Verdict]")) },
                            { term: "Reply speed", text: plainText(readText(row, "[Response Read]")) },
                        ]}
                    />
                </div>
            </div>
        </Section>
    );
}
