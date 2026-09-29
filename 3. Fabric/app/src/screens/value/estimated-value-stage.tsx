//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type KeyboardEvent } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { stageAnchor } from "@/components/destinations";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { treatAs } from "@/lib/dax-filters";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    agentValue,
    AGENT_NAME_COLUMN,
    organizationValue,
    ORGANIZATION_COLUMN,
    valueByTaskGroup,
    valueSummary,
} from "@/queries/value";

type Scenario = "Conservative" | "Typical" | "Optimistic";

const scenarios: { id: Scenario; label: string }[] = [
    { id: "Conservative", label: "Conservative" },
    { id: "Typical", label: "Typical" },
    { id: "Optimistic", label: "Optimistic" },
];

const clampRate = (value: number): number => Math.min(1000, Math.max(0, value));

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCurrencyCell(value: unknown, currencySymbol: string): string {
    return formatKpi(asNumber(value), "currency", { prefix: currencySymbol });
}

function formatHoursCell(value: unknown): string {
    return formatKpi(asNumber(value), "hours");
}

function formatWholeCell(value: unknown): string {
    return formatKpi(asNumber(value), "whole");
}

/**
 * The report's Estimated Value page, reworked as an explicit assumption model.
 *
 * The numbers are estimates of what the recorded work would have cost at the
 * chosen hourly rate, not booked savings. Value is read first in total, then
 * by task group, agent and organization so the assumptions stay visible.
 */
export function EstimatedValueStage() {
    const [rate, setRate] = useState(50);
    const [draftRate, setDraftRate] = useState("50");
    const [scenario, setScenario] = useState<Scenario>("Typical");
    const { theme } = useThemeContext();

    const extra = useMemo(
        () => [
            treatAs("'Hourly Value'[Hourly Value]", [rate]),
            treatAs("'Effort Scenario'[Scenario]", [scenario]),
        ],
        [rate, scenario],
    );

    const summary = valueSummary();
    const summaryResult = useFilteredQuery({ connection: summary.connection, query: summary.query }, { extra });
    const taskGroups = valueByTaskGroup();
    const taskGroupResult = useFilteredQuery(
        { connection: taskGroups.connection, query: taskGroups.query },
        { extra },
    );
    const agents = agentValue();
    const agentResult = useFilteredQuery({ connection: agents.connection, query: agents.query }, { extra });
    const organizations = organizationValue();
    const organizationResult = useFilteredQuery(
        { connection: organizations.connection, query: organizations.query },
        { extra },
    );

    const summaryRow = useMemo(
        () => (summaryResult.data?.status === "success" ? toSummaryRow(summaryResult.data.table) : undefined),
        [summaryResult.data],
    );
    const taskGroupTable = useMemo(
        () =>
            taskGroupResult.data?.status === "success"
                ? toDataTable(taskGroupResult.data.table, taskGroups.columnMetadata)
                : undefined,
        [taskGroupResult.data, taskGroups.columnMetadata],
    );
    const agentTable = useMemo(
        () =>
            agentResult.data?.status === "success"
                ? toDataTable(agentResult.data.table, agents.columnMetadata)
                : undefined,
        [agentResult.data, agents.columnMetadata],
    );
    const organizationTable = useMemo(
        () =>
            organizationResult.data?.status === "success"
                ? toDataTable(organizationResult.data.table, organizations.columnMetadata)
                : undefined,
        [organizationResult.data, organizations.columnMetadata],
    );

    const currencySymbol = readText(summaryRow, "[Currency Symbol]") ?? "";
    // Both grids fill the same row, so size them to the longer list.
    const tablesHeight =
        agentTable && organizationTable
            ? gridHeight(Math.max(agentTable.rows.length, organizationTable.rows.length), { max: 520 })
            : undefined;
    const assumption = `At ${currencySymbol}${formatKpi(rate, "whole")} an hour, ${scenario.toLowerCase()} effort`;

    const commitRate = () => {
        const parsed = Number.parseFloat(draftRate);
        if (!Number.isFinite(parsed)) {
            setDraftRate(String(rate));
            return;
        }
        const next = clampRate(parsed);
        setRate(next);
        setDraftRate(String(next));
    };

    const onRateKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.currentTarget.blur();
        }
    };

    const agentColumns: GridColumnDef[] = useMemo(
        () => [
            { id: AGENT_NAME_COLUMN, header: "Agent", minWidth: 220 },
            {
                id: "Active Agent Users",
                header: "Users",
                width: 88,
                numericStyling: true,
                cellRenderer: formatWholeCell,
            },
            {
                id: "Observed Agent Sessions",
                header: "Sessions",
                width: 96,
                numericStyling: true,
                cellRenderer: formatWholeCell,
            },
            {
                id: "Expert Equivalent Hours",
                header: "Hours",
                width: 88,
                numericStyling: true,
                cellRenderer: formatHoursCell,
            },
            {
                id: "AI Assisted Value",
                header: `Value (${currencySymbol || "currency"})`,
                width: 140,
                numericStyling: true,
                cellRenderer: (value) => formatCurrencyCell(value, currencySymbol),
            },
        ],
        [currencySymbol],
    );

    const organizationColumns: GridColumnDef[] = useMemo(
        () => [
            { id: ORGANIZATION_COLUMN, header: "Organization", minWidth: 180 },
            {
                id: "Active Users",
                header: "Active users",
                width: 132,
                numericStyling: true,
                cellRenderer: formatWholeCell,
            },
            {
                id: "Expert Equivalent Hours Per Week",
                header: "Hours per week",
                width: 152,
                numericStyling: true,
                cellRenderer: formatHoursCell,
            },
            {
                id: "AI Assisted Value",
                header: `Value (${currencySymbol || "currency"})`,
                width: 140,
                numericStyling: true,
                cellRenderer: (value) => formatCurrencyCell(value, currencySymbol),
            },
        ],
        [currencySymbol],
    );

    return (
        <Section
            id={stageAnchor("estimated-value")}
            title="Estimated value"
            description="What the recorded work would have cost at the chosen rate — an estimate, not a saving."
            actions={
                <div className="flex flex-wrap items-center gap-200">
                    <label className="flex items-center gap-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        <span>Hourly rate</span>
                        <span className="flex h-700 items-center rounded-md border border-border bg-card text-card-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
                            <span className="border-r border-border px-200 text-muted-foreground" aria-hidden="true">
                                {currencySymbol}
                            </span>
                            <input
                                aria-label="Hourly rate"
                                type="number"
                                min={0}
                                max={1000}
                                step={1}
                                size={4}
                                value={draftRate}
                                onChange={(event) => setDraftRate(event.currentTarget.value)}
                                onBlur={commitRate}
                                onKeyDown={onRateKeyDown}
                                className="bg-transparent px-200 py-100 text-right font-numeric text-[length:var(--text-200)] tabular-nums outline-none"
                            />
                        </span>
                    </label>
                    <SegmentedControl label="Scenario" options={scenarios} value={scenario} onChange={setScenario} />
                </div>
            }
        >
            {summaryResult.data?.status === "error" ? (
                <QueryError message={summaryResult.data.error.message} onRetry={summaryResult.refetch} />
            ) : summaryResult.isLoading || !summaryResult.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No estimated value"
                    description="The semantic model returned no rows. Check that the model has been refreshed since the last data load."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <KpiCard
                        label="Expert-equivalent hours per week"
                        value={readNumber(summaryRow, "[Expert Equivalent Hours Per Week]")}
                        format="hours"
                    />
                    <KpiCard
                        label="AI assisted value"
                        value={readNumber(summaryRow, "[AI Assisted Value]")}
                        format="currency"
                        prefix={currencySymbol}
                        emphasis
                    />
                    <KpiCard
                        label="Annualised value"
                        value={readNumber(summaryRow, "[Projected Annualised Value]")}
                        format="currency"
                        prefix={currencySymbol}
                    />
                    <KpiCard
                        label="Value per week"
                        value={readNumber(summaryRow, "[AI Assisted Value Per Week]")}
                        format="currency"
                        prefix={currencySymbol}
                    />
                </div>
            )}

            <p className="max-w-[68ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                {assumption}
            </p>

            <div
                className="h-[380px]"
                style={taskGroupTable ? { height: rowChartHeight(taskGroupTable.rows.length, { perRow: 40, chrome: 100 }) } : undefined}
            >
                {taskGroupResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={taskGroupResult.data.error.message}
                        onRetry={taskGroupResult.refetch}
                    />
                ) : taskGroupResult.isLoading || !taskGroupTable ? (
                    <QueryLoading className="h-full" />
                ) : taskGroupTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No value to break down"
                        description="No recorded work carries both a task group and an estimated value for this slice."
                    />
                ) : (
                    <VegaVisual
                        spec={taskGroups.vegaLiteSpec}
                        data={taskGroupTable}
                        theme={theme}
                        header={{
                            title: "Where the value comes from",
                            subtitle: `Estimated value by task group, ${assumption.toLowerCase()}`,
                        }}
                    />
                )}
            </div>

            <div className="grid gap-300 xl:grid-cols-2">
                <div className="flex h-[520px] flex-col" style={tablesHeight ? { height: tablesHeight } : undefined}>
                    {agentResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={agentResult.data.error.message}
                            onRetry={agentResult.refetch}
                        />
                    ) : agentResult.isLoading || !agentTable ? (
                        <QueryLoading className="h-full" />
                    ) : agentTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No agent value in this slice"
                            description="The agents table is empty when the Activity filter is set to Copilot chat, or when no named agents have recorded sessions."
                        />
                    ) : (
                        <DataGrid
                            columns={agentColumns}
                            data={agentTable}
                            defaultSort={[{ columnId: "AI Assisted Value", direction: "desc" }]}
                            theme={theme}
                            header={{
                                title: "Agents",
                                subtitle: "Named agents, highest estimated value first",
                            }}
                        />
                    )}
                </div>

                <div className="flex h-[520px] flex-col" style={tablesHeight ? { height: tablesHeight } : undefined}>
                    {organizationResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={organizationResult.data.error.message}
                            onRetry={organizationResult.refetch}
                        />
                    ) : organizationResult.isLoading || !organizationTable ? (
                        <QueryLoading className="h-full" />
                    ) : organizationTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No organizations to compare"
                            description="No rows carry both an organization and an estimated value for this slice."
                        />
                    ) : (
                        <DataGrid
                            columns={organizationColumns}
                            data={organizationTable}
                            defaultSort={[{ columnId: "AI Assisted Value", direction: "desc" }]}
                            theme={theme}
                            header={{
                                title: "Organizations",
                                subtitle: "Users, weekly hours and value in one view",
                            }}
                        />
                    )}
                </div>
            </div>
        </Section>
    );
}
