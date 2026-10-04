//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { ChoiceMenu } from "@/components/choice-menu";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { readNumber, readText } from "@/lib/summary-row";
import { formatCell } from "@/lib/tree-grid";
import {
    breakdownRows,
    groupByChoices,
    groupByFilter,
    studioAgents,
    studioBreakdown,
    studioCreditsSummary,
    studioDaily,
    studioPeriodFilter,
    studioUsers,
    STUDIO_LABEL_COLUMN,
    toStudioUserTree,
    type ConsumptionLens,
    type ConsumptionOptions,
} from "@/queries/consumption";
import { AzureBilledPanel } from "./azure-billed";
import { CREDIT_CURRENCY, LENSES, moneyCell, standalone, useConsumptionSummary, useConsumptionTable } from "./data";
import { ChartPanel, KpiRowState, NoteCard, Panel, RollupGrid, type TreeColumn } from "@/components/report-panels";

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-5";
const money = moneyCell(CREDIT_CURRENCY);
const BREAKDOWN_CHART = { perRow: 36, chrome: 130, min: 220 };
// A label on each of ~90 daily bars can't fit; the tooltip carries the numbers.
const NO_STACK_LABELS = { disableStackedDataLabels: true };

const CONSUMPTION_COLUMNS: readonly TreeColumn[] = [
    { id: "Credits Used", header: "Credits used", width: 128, format: formatCell("whole"), heat: true },
    { id: "Credit Share", header: "Share", width: 96, format: formatCell("percent") },
    { id: "Policy", header: "Billing policy", width: 184 },
];

const COST_COLUMNS: readonly TreeColumn[] = [
    { id: "Billable Credits", header: "Billable credits", width: 140, format: formatCell("whole") },
    { id: "Estimated Cost", header: "Estimated cost", width: 140, format: money, heat: true },
];

/** The model's own "all days" period, which is what the page shows before anyone picks one. */
function defaultStudioPeriod(periods: readonly string[]): string | undefined {
    return periods.find((period) => /^all\b/i.test(period)) ?? periods[periods.length - 1];
}

interface StudioStageProps {
    options: ConsumptionOptions | undefined;
    rates: string | undefined;
}

/**
 * The report's two Copilot Studio pages as one stage. Tenant totals follow
 * the period; the per-agent and per-user tables come from an undated export
 * snapshot, as the report's own note says.
 */
export function StudioStage({ options, rates }: StudioStageProps) {
    const { theme } = useThemeContext();
    const [lens, setLens] = useState<ConsumptionLens>("consumption");
    const [period, setPeriod] = useState<string>();
    const [groupBy, setGroupBy] = useState<string>();

    const periods = useMemo(() => options?.studioPeriods ?? [], [options?.studioPeriods]);
    const allPeriods = defaultStudioPeriod(periods);
    const groupChoices = useMemo(() => groupByChoices(options?.groupBy ?? [], "Studio"), [options?.groupBy]);

    const extra = useMemo(
        () => [groupByFilter(groupBy), ...(period ? [studioPeriodFilter(period)] : [])],
        [groupBy, period],
    );

    const summary = useConsumptionSummary(studioCreditsSummary(), extra);
    const dailySource = studioDaily(lens);
    const daily = useConsumptionTable(dailySource, extra);
    const breakdownSource = studioBreakdown(lens);
    const breakdown = useConsumptionTable(breakdownSource, extra);
    const agents = useConsumptionTable(studioAgents(), extra);
    const users = useConsumptionTable(studioUsers(), extra);

    const row = summary.row;
    const cost = lens === "cost";
    // Studio users only group once they can be matched to the org directory.
    const matchRate = readNumber(row, "[Org Match Rate]") ?? 0;
    const canGroup = matchRate > 0 && groupChoices.length > 0;
    const groupLabel = groupChoices.find((choice) => choice.value === groupBy)?.label;

    const models = useMemo(() => (breakdown.table ? breakdownRows(breakdown.table, "Model") : undefined), [breakdown.table]);
    const features = useMemo(() => (breakdown.table ? breakdownRows(breakdown.table, "Feature") : undefined), [breakdown.table]);

    const agentColumns: GridColumnDef[] = useMemo(() => {
        const table = agents.table;
        return cost
            ? [
                  { id: "Agent", header: "Agent", width: 240 },
                  { id: "Billable Credits", header: "Billable credits", width: 140, numericStyling: true, cellRenderer: formatCell("whole") },
                  {
                      id: "Estimated Cost",
                      header: "Estimated cost",
                      width: 140,
                      numericStyling: true,
                      cellRenderer: heatRenderer({ domain: columnHeat(table, "Estimated Cost"), format: money }),
                  },
              ]
            : [
                  { id: "Agent", header: "Agent", width: 240 },
                  {
                      id: "Credits Used",
                      header: "Credits used",
                      width: 128,
                      numericStyling: true,
                      cellRenderer: heatRenderer({ domain: columnHeat(table, "Credits Used"), format: formatCell("whole") }),
                  },
                  { id: "Credit Share", header: "Share", width: 96, numericStyling: true, cellRenderer: formatCell("percent") },
              ];
    }, [agents.table, cost]);

    const breakdownHeight = rowChartHeight(Math.max(models?.rows.length ?? 3, features?.rows.length ?? 3), BREAKDOWN_CHART);

    return (
        <Section
            id={stageAnchor("studio-credits")}
            title="Copilot Studio"
            description={
                cost
                    ? "What agents cost: prepaid capacity, pay-as-you-go and the rate they blend to."
                    : "Who is using agents, and how many credits they consume."
            }
            actions={
                <div className="flex flex-wrap items-center gap-200">
                    {periods.length > 1 && allPeriods && (
                        <ChoiceMenu
                            label="Period"
                            allLabel={allPeriods}
                            choices={periods.filter((value) => value !== allPeriods).map((value) => ({ value, label: value }))}
                            value={period}
                            onChange={setPeriod}
                        />
                    )}
                    {canGroup && (
                        <ChoiceMenu
                            label="Group by"
                            allLabel="All users"
                            choices={groupChoices}
                            value={groupBy}
                            onChange={setGroupBy}
                        />
                    )}
                    <SegmentedControl label="Copilot Studio view" options={LENSES} value={lens} onChange={setLens} />
                </div>
            }
        >
            <KpiRowState
                summary={summary}
                count={5}
                className={KPI_GRID}
                emptyTitle="No Copilot Studio credits"
                emptyDescription="Consumption Central has no Copilot Studio credit rows for this period. Check that the Power Platform export has loaded."
            >
                {cost ? (
                    <>
                        <KpiCard
                            label="Total cost"
                            value={readNumber(row, "[Total Cost]")}
                            format="money"
                            prefix={CREDIT_CURRENCY}
                            emphasis
                            detail={
                                <div className="flex flex-col gap-100">
                                    <KpiStat label="Prepaid" value={readNumber(row, "[Prepaid Cost]")} format="money" prefix={CREDIT_CURRENCY} />
                                    <KpiStat label="Pay-as-you-go" value={readNumber(row, "[PAYG Cost]")} format="money" prefix={CREDIT_CURRENCY} />
                                </div>
                            }
                        />
                        <KpiCard label="Pay-as-you-go share" value={readNumber(row, "[PAYG Share]")} format="percent" />
                        <KpiCard
                            label="Effective rate"
                            value={readNumber(row, "[Effective Rate]")}
                            format="price"
                            prefix={CREDIT_CURRENCY}
                            detail="Per credit, prepaid and pay-as-you-go together"
                        />
                        <KpiCard
                            label="Cost per user"
                            value={readNumber(row, "[Avg Cost Per User]")}
                            format="money"
                            prefix={CREDIT_CURRENCY}
                        />
                        <KpiCard label="Credits consumed" value={readNumber(row, "[Credits Consumed]")} />
                    </>
                ) : (
                    <>
                        <KpiCard
                            label="Credits consumed"
                            value={readNumber(row, "[Credits Consumed]")}
                            emphasis
                            detail={standalone(readText(row, "[Period Label]"))}
                        />
                        <KpiCard label="Active users" value={readNumber(row, "[Active Users]")} />
                        <KpiCard label="Agents with credits" value={readNumber(row, "[Agents With Credits]")} />
                        <KpiCard label="Credits per user" value={readNumber(row, "[Avg Credits Per User]")} />
                        <KpiCard label="Agents per user" value={readNumber(row, "[Avg Agents Per User]")} format="rate" />
                    </>
                )}
            </KpiRowState>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={daily}
                    spec={dailySource.vegaLiteSpec}
                    capabilities={NO_STACK_LABELS}
                    height={340}
                    title={cost ? "Cost over time" : "Consumption over time"}
                    subtitle={cost ? "Tenant cost each day, prepaid then pay-as-you-go" : "Tenant credits each day, prepaid then pay-as-you-go"}
                    emptyTitle="No daily credits"
                    emptyDescription="The tenant export has no days with Copilot Studio credits in this period."
                />
                <NoteCard
                    title="About these figures"
                    notes={[
                        { term: "Billing period", text: readText(row, "[Billing Period]") },
                        { term: "Concentration", text: readText(row, "[Concentration]") },
                        { term: "User snapshot", text: readText(row, "[Snapshot Note]") },
                        { term: "Group by", text: canGroup ? undefined : readText(row, "[Org Filter Status]") },
                        { term: "Rates in use", text: rates },
                    ]}
                />
            </div>

            <AzureBilledPanel lens={lens} extra={extra} />

            <div className="grid grid-cols-1 gap-500 md:grid-cols-2">
                <ChartPanel
                    result={breakdown}
                    table={models}
                    spec={breakdownSource.vegaLiteSpec}
                    height={breakdownHeight}
                    title={cost ? "Cost by model" : "Consumption by model"}
                    subtitle="The model behind each agent's credits"
                    emptyTitle="No model detail"
                    emptyDescription="The agent export does not name a model for these credits."
                />
                <ChartPanel
                    result={breakdown}
                    table={features}
                    spec={breakdownSource.vegaLiteSpec}
                    height={breakdownHeight}
                    title={cost ? "Cost by feature" : "Consumption by feature"}
                    subtitle="The billable feature each credit was spent on"
                    emptyTitle="No feature detail"
                    emptyDescription="The agent export does not name a billable feature for these credits."
                />
            </div>

            <div className="grid grid-cols-1 items-start gap-500 2xl:grid-cols-2">
                <Panel
                    result={agents}
                    height={gridHeight(agents.table?.rows.length ?? 6)}
                    emptyTitle="No agents in the snapshot"
                    emptyDescription="The user snapshot has no agents with credits."
                >
                    {(table) => (
                        <DataGrid
                            key={lens}
                            columns={agentColumns}
                            data={table}
                            theme={theme}
                            header={{
                                title: cost ? "Agents — estimated cost" : "Agents in the user snapshot",
                                subtitle: cost ? "Billable credits and what they cost" : "Credits and each agent's share of them",
                            }}
                        />
                    )}
                </Panel>
                <RollupGrid
                    result={users}
                    toTree={toStudioUserTree}
                    labelColumn={STUDIO_LABEL_COLUMN}
                    labelHeader={`${groupLabel ?? "Group"} / user`}
                    columns={cost ? COST_COLUMNS : CONSUMPTION_COLUMNS}
                    variant={lens}
                    title={cost ? "Users — estimated cost" : "Top users by consumption"}
                    subtitle="From the user snapshot, largest first"
                    emptyTitle="No users in the snapshot"
                    emptyDescription="The user snapshot has no one with Copilot Studio credits."
                />
            </div>
        </Section>
    );
}
