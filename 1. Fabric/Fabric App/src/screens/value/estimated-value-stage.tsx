//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type KeyboardEvent } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { SCENARIOS, useValueAssumptions } from "@/hooks/value-assumptions.context";
import { gridHeight } from "@/lib/chart-height";
import { treatAs } from "@/lib/dax-filters";
import { formatKpi } from "@/lib/format-kpi";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { withIndefiniteArticle, withOrgAttribute } from "@/lib/org-attribute";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    agentValue,
    AGENT_NAME_COLUMN,
    organizationValue,
    ORGANIZATION_COLUMN,
    valueSummary,
} from "@/queries/value";
import { TaskValueBreakdown } from "./task-value-breakdown";

const scenarios = SCENARIOS.map((id) => ({ id, label: id }));

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
    const { rate, setRate, scenario, setScenario } = useValueAssumptions();
    const [draftRate, setDraftRate] = useState(() => String(rate));
    const { theme } = useThemeContext();
    const org = useOrgAttribute();

    const extra = useMemo(
        () => [
            treatAs("'Hourly Value'[Hourly Value]", [rate]),
            treatAs("'Effort Scenario'[Scenario]", [scenario]),
        ],
        [rate, scenario],
    );

    const summary = valueSummary();
    const summaryResult = useFilteredQuery({ connection: summary.connection, query: summary.query }, { extra });
    const agents = agentValue();
    const agentResult = useFilteredQuery({ connection: agents.connection, query: agents.query }, { extra });
    const organizations = useMemo(() => withOrgAttribute(organizationValue(), org), [org]);
    const organizationResult = useFilteredQuery(
        { connection: organizations.connection, query: organizations.query },
        { extra },
    );

    const summaryRow = useMemo(
        () => (summaryResult.data?.status === "success" ? toSummaryRow(summaryResult.data.table) : undefined),
        [summaryResult.data],
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
                cellRenderer: heatRenderer({
                    domain: columnHeat(agentTable, "AI Assisted Value"),
                    format: (value) => formatCurrencyCell(value, currencySymbol),
                }),
            },
        ],
        [currencySymbol, agentTable],
    );

    const organizationColumns: GridColumnDef[] = useMemo(
        () => [
            { id: ORGANIZATION_COLUMN, header: org.label, minWidth: 180 },
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
                cellRenderer: heatRenderer({
                    domain: columnHeat(organizationTable, "AI Assisted Value"),
                    format: (value) => formatCurrencyCell(value, currencySymbol),
                }),
            },
        ],
        [currencySymbol, org.label, organizationTable],
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

            <TaskValueBreakdown extra={extra} currencySymbol={currencySymbol} assumption={assumption} />

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
                            title={`No ${org.plural} to compare`}
                            description={`No rows carry both ${withIndefiniteArticle(org.noun)} and an estimated value for this slice.`}
                        />
                    ) : (
                        <DataGrid
                            columns={organizationColumns}
                            data={organizationTable}
                            defaultSort={[{ columnId: "AI Assisted Value", direction: "desc" }]}
                            theme={theme}
                            header={{
                                title: org.plural.charAt(0).toUpperCase() + org.plural.slice(1),
                                subtitle: "Users, weekly hours and value in one view",
                            }}
                        />
                    )}
                </div>
            </div>
        </Section>
    );
}
