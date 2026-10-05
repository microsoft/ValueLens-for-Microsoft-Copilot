//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { ChoiceMenu } from "@/components/choice-menu";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { readNumber, readText } from "@/lib/summary-row";
import { formatCell } from "@/lib/tree-grid";
import {
    coworkByGroup,
    coworkCreditsSummary,
    coworkPeriodFilter,
    coworkWeekly,
    COWORK_LABEL_COLUMN,
    groupByChoices,
    groupByFilter,
    serviceFilter,
    serviceLabel,
    studioAzureBilling,
    toCoworkGroupTree,
    type ConsumptionLens,
    type ConsumptionOptions,
} from "@/queries/consumption";
import { billedText, readAzureBilling } from "./azure-billing";
import { CREDIT_CURRENCY, LENSES, moneyCell, standalone, useConsumptionSummary, useConsumptionTable } from "./data";
import { ChartPanel, KpiRowState, NoteCard, RollupGrid, type TreeColumn } from "@/components/report-panels";

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-5";
const money = moneyCell(CREDIT_CURRENCY);
// A white label inside every prepaid and pay-as-you-go segment reads as noise
// (and a 0 on each empty one); the tooltip carries the numbers.
const NO_STACK_LABELS = { disableStackedDataLabels: true };

const CONSUMPTION_COLUMNS: readonly TreeColumn[] = [
    { id: "Users", header: "Users", width: 80, format: formatCell("whole"), groupOnly: true },
    { id: "Credits Used", header: "Credits used", width: 120, format: formatCell("whole"), heat: true },
    { id: "Allowance Used", header: "Allowance used", width: 136, format: formatCell("percent") },
    { id: "Policy", header: "Policy", width: 140 },
];

const COST_COLUMNS: readonly TreeColumn[] = [
    { id: "Credits Used", header: "Credits used", width: 120, format: formatCell("whole") },
    { id: "Prepaid Cost", header: "Prepaid", width: 108, format: money },
    { id: "PAYG Cost", header: "Pay-as-you-go", width: 132, format: money },
    { id: "Total Cost", header: "Total cost", width: 116, format: money, heat: true },
];

interface CoworkStageProps {
    options: ConsumptionOptions | undefined;
    rates: string | undefined;
}

/**
 * The report's two Cowork / Work IQ pages as one stage: what was consumed,
 * then what it cost, prepaid capacity first and pay-as-you-go after it.
 */
export function CoworkStage({ options, rates }: CoworkStageProps) {
    const [lens, setLens] = useState<ConsumptionLens>("consumption");
    const [period, setPeriod] = useState<string>();
    const [service, setService] = useState<string>();
    const [groupBy, setGroupBy] = useState<string>();

    const periods = options?.coworkPeriods ?? [];
    const services = useMemo(
        () => (options?.services ?? []).map((value) => ({ value, label: serviceLabel(value) })),
        [options?.services],
    );
    const groupChoices = useMemo(() => groupByChoices(options?.groupBy ?? [], "Cowork"), [options?.groupBy]);
    const groupLabel = groupChoices.find((choice) => choice.value === groupBy)?.label;

    const extra = useMemo(
        () => [
            groupByFilter(groupBy),
            ...(period ? [coworkPeriodFilter(period)] : []),
            ...(service ? [serviceFilter(service)] : []),
        ],
        [groupBy, period, service],
    );

    const summary = useConsumptionSummary(coworkCreditsSummary(), extra);
    const weeklySource = coworkWeekly(lens);
    const weekly = useConsumptionTable(weeklySource, extra);
    const byGroup = useConsumptionTable(coworkByGroup(), extra);
    const row = summary.row;
    const cost = lens === "cost";
    // Azure's daily billing has no Cowork weeks to follow, so it reads every day it has.
    const azure = readAzureBilling(useConsumptionSummary(studioAzureBilling()));
    const azureBilled = azure && billedText(azure, azure.coworkCost, azure.coworkCredits);
    const azureText = azureBilled && `${azureBilled} of pay-as-you-go, ${azure.window}, as Azure Cost Management recorded it.`;

    return (
        <Section
            id={stageAnchor("cowork-credits")}
            title="Cowork / Work IQ"
            description={
                cost
                    ? "What the credits cost: prepaid capacity first, then pay-as-you-go once the packs run out."
                    : "Who is consuming credits, and how much of their allowance it uses."
            }
            actions={
                <div className="flex flex-wrap items-center gap-200">
                    {periods.length > 0 && (
                        <ChoiceMenu
                            label="Period"
                            allLabel={periods[0]}
                            choices={periods.slice(1).map((value) => ({ value, label: value }))}
                            value={period}
                            onChange={setPeriod}
                        />
                    )}
                    {services.length > 1 && (
                        <ChoiceMenu
                            label="Service"
                            allLabel="Cowork and Work IQ"
                            choices={services}
                            value={service}
                            onChange={setService}
                        />
                    )}
                    {groupChoices.length > 0 && (
                        <ChoiceMenu
                            label="Group by"
                            allLabel="All users"
                            choices={groupChoices}
                            value={groupBy}
                            onChange={setGroupBy}
                        />
                    )}
                    <SegmentedControl label="Cowork view" options={LENSES} value={lens} onChange={setLens} />
                </div>
            }
        >
            <KpiRowState
                summary={summary}
                count={5}
                className={KPI_GRID}
                emptyTitle="No Cowork credits"
                emptyDescription="Consumption Central has no Cowork or Work IQ credit rows for this period. Check that the credit export has loaded."
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
                        <KpiCard
                            label="Blended rate"
                            value={readNumber(row, "[Blended Rate]")}
                            format="price"
                            prefix={CREDIT_CURRENCY}
                            detail="Per credit, prepaid and pay-as-you-go together"
                        />
                        <KpiCard label="Credits used" value={readNumber(row, "[Credits Used]")} />
                        <KpiCard
                            label="Cost per user"
                            value={readNumber(row, "[Avg Cost Per User]")}
                            format="money"
                            prefix={CREDIT_CURRENCY}
                            detail="Across consuming users"
                        />
                        <KpiCard
                            label="Policy headroom"
                            value={readNumber(row, "[Policy Headroom]")}
                            detail="Credits left under the policy allowances"
                        />
                    </>
                ) : (
                    <>
                        <KpiCard
                            label="Credits used"
                            value={readNumber(row, "[Credits Used]")}
                            emphasis
                            detail={standalone(readText(row, "[Period Label]"))}
                        />
                        <KpiCard
                            label="Consuming users"
                            value={readNumber(row, "[Consuming Users]")}
                            detail={<KpiStat label="Active each week" value={readNumber(row, "[Weekly Active Users]")} />}
                        />
                        <KpiCard label="Credits per user" value={readNumber(row, "[Avg Credits Per User]")} />
                        <KpiCard
                            label="Allowance used"
                            value={readNumber(row, "[Allowance Used]")}
                            format="percent"
                            detail={<KpiStat label="Users over limit" value={readNumber(row, "[Users Over Limit]")} format="percent" />}
                        />
                        <KpiCard label="Spending policies" value={readNumber(row, "[Policies]")} />
                    </>
                )}
            </KpiRowState>

            <ChartPanel
                result={weekly}
                spec={weeklySource.vegaLiteSpec}
                capabilities={NO_STACK_LABELS}
                height={340}
                title={cost ? "Cost over time" : "Credit consumption over time"}
                subtitle={
                    cost
                        ? "Prepaid and pay-as-you-go cost for each week in the period"
                        : "Credits each week, across every week the export holds"
                }
                emptyTitle="No weekly credits"
                emptyDescription="The credit export has no weeks for this service yet."
            />

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <RollupGrid
                    result={byGroup}
                    toTree={toCoworkGroupTree}
                    labelColumn={COWORK_LABEL_COLUMN}
                    labelHeader={`${groupLabel ?? "Group"} / person`}
                    labelWidth={232}
                    columns={cost ? COST_COLUMNS : CONSUMPTION_COLUMNS}
                    variant={lens}
                    title={cost ? "Cost by group" : "Credits by group"}
                    subtitle={
                        cost
                            ? "Each group, then its people. Pay-as-you-go is only allocated to the tenant total."
                            : "Each group, then its people, largest first"
                    }
                    emptyTitle="Nobody consumed credits"
                    emptyDescription="No one in this period and service used Cowork or Work IQ credits."
                />
                <NoteCard
                    title="How it is billed"
                    notes={[
                        { term: "Period", text: standalone(readText(row, "[Period Label]")) },
                        { term: "Billing basis", text: readText(row, "[Billing Basis]") },
                        { term: "Rates in use", text: rates },
                        { term: "Billed in Azure", text: azureText },
                    ]}
                />
            </div>
        </Section>
    );
}
