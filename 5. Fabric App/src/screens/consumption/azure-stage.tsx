//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { readNumber, readText } from "@/lib/summary-row";
import { formatCell } from "@/lib/tree-grid";
import {
    azureCurrencyFilter,
    azureMode,
    azureSolutionByService,
    azureSolutionDaily,
    azureSolutionResources,
    azureSolutionSummary,
    azureSource,
    costBasisFilter,
    currencyPrefix,
    foundryByModel,
    foundryDaily,
    foundryResources,
    foundrySummary,
    type ConsumptionOptions,
} from "@/queries/consumption";
import { moneyCell, SMALL, useConsumptionSummary, useConsumptionTable, type TableResult } from "./data";
import { ChartPanel, KpiRowState, NoteCard, Panel } from "@/components/report-panels";

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-5";
const BY_ITEM_CHART = { perRow: 40, chrome: 130, min: 240 };

function itemChartHeight(result: TableResult): number {
    return rowChartHeight(result.table?.rows.length ?? 5, BY_ITEM_CHART);
}

interface ResourceGridProps {
    result: TableResult;
    prefix: string;
    /** Text columns before the cost, in the order the report shows them. */
    labels: readonly { id: string; header: string; width: number }[];
    tokens?: boolean;
    title: string;
    subtitle: string;
}

/** The report's resource table, with the cost shaded so the big spenders stand out. */
function ResourceGrid({ result, prefix, labels, tokens, title, subtitle }: ResourceGridProps) {
    const { theme } = useThemeContext();
    const columns: GridColumnDef[] = useMemo(
        () => [
            ...labels.map((label): GridColumnDef => ({ id: label.id, header: label.header, width: label.width })),
            {
                id: "Cost",
                header: "Cost",
                width: 128,
                numericStyling: true,
                cellRenderer: heatRenderer({ domain: columnHeat(result.table, "Cost"), format: moneyCell(prefix) }),
            },
            ...(tokens
                ? [{ id: "Tokens M", header: "Tokens", width: 112, numericStyling: true, cellRenderer: formatCell("millions") }]
                : []),
        ],
        [labels, prefix, result.table, tokens],
    );

    return (
        <Panel
            result={result}
            height={gridHeight(result.table?.rows.length ?? 6)}
            emptyTitle="No resources"
            emptyDescription="The Azure export has no resources with cost for these filters."
        >
            {(table) => <DataGrid columns={columns} data={table} theme={theme} header={{ title, subtitle }} />}
        </Panel>
    );
}

const FOUNDRY_LABELS = [
    { id: "Resource", header: "Resource", width: 200 },
    { id: "Resource Group", header: "Resource group", width: 180 },
    { id: "Model", header: "Model", width: 180 },
    { id: "Department Tag", header: "Department tag", width: 160 },
] as const;

/** The model spend Consumption Central always loads, shown when no whole-solution export is present. */
function FoundryView({ currency }: { currency: string | undefined }) {
    const prefix = currencyPrefix(currency);
    const summary = useConsumptionSummary(foundrySummary());
    const dailySource = foundryDaily();
    const daily = useConsumptionTable(dailySource);
    const byModelSource = foundryByModel();
    const byModel = useConsumptionTable(byModelSource);
    const resources = useConsumptionTable(foundryResources());
    const row = summary.row;
    const days = readNumber(row, "[Days Observed]");

    return (
        <>
            <p className={`${SMALL} max-w-[68ch] text-muted-foreground`}>
                No whole-solution Azure cost export is loaded, so this shows Azure AI Foundry model spend instead.
                {currency ? ` Figures are in ${currency}.` : ""}
            </p>

            <KpiRowState
                summary={summary}
                count={5}
                className={KPI_GRID}
                emptyTitle="No Foundry spend"
                emptyDescription="The Foundry export has no model cost yet."
            >
                <KpiCard
                    label="Foundry cost"
                    value={readNumber(row, "[Cost]")}
                    format="money"
                    prefix={prefix}
                    emphasis
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Input tokens" value={readNumber(row, "[Input Cost]")} format="money" prefix={prefix} />
                            <KpiStat label="Output tokens" value={readNumber(row, "[Output Cost]")} format="money" prefix={prefix} />
                        </div>
                    }
                />
                <KpiCard
                    label="Tokens"
                    value={readNumber(row, "[Tokens M]")}
                    format="millions"
                    detail={<KpiStat label="Output share" value={readNumber(row, "[Output Share]")} format="percent" />}
                />
                <KpiCard label="Cost per 1M tokens" value={readNumber(row, "[Cost Per 1M Tokens]")} format="money" prefix={prefix} />
                <KpiCard
                    label="AI requests"
                    value={readNumber(row, "[AI Requests]")}
                    detail={<KpiStat label="Tokens per request" value={readNumber(row, "[Tokens Per Request]")} />}
                />
                <KpiCard
                    label="Daily run rate"
                    value={readNumber(row, "[Daily Run Rate]")}
                    format="money"
                    prefix={prefix}
                    detail={<KpiStat label="A month at this rate" value={readNumber(row, "[Cost Per Month]")} format="money" prefix={prefix} />}
                />
            </KpiRowState>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={daily}
                    spec={dailySource.vegaLiteSpec}
                    height={340}
                    title="Foundry cost over time"
                    subtitle="Each day's spend, input tokens then output tokens"
                    emptyTitle="No daily spend"
                    emptyDescription="The Foundry export has no days with cost yet."
                />
                <NoteCard
                    title="Provisioned capacity"
                    notes={[
                        { term: "Should you buy PTUs?", text: readText(row, "[PTU Verdict]") },
                        { term: "Days observed", text: days === undefined ? undefined : String(days) },
                    ]}
                />
            </div>

            <ChartPanel
                result={byModel}
                spec={byModelSource.vegaLiteSpec}
                height={itemChartHeight(byModel)}
                title="Cost by model"
                subtitle="Where the token spend goes"
                emptyTitle="No model spend"
                emptyDescription="No model has cost in the Foundry export yet."
            />

            <ResourceGrid
                result={resources}
                prefix={prefix}
                labels={FOUNDRY_LABELS}
                tokens
                title="Foundry resources"
                subtitle="Each deployment's cost, and the department its tags allocate it to"
            />
        </>
    );
}

const SOLUTION_LABELS = [
    { id: "Resource", header: "Resource", width: 200 },
    { id: "Application", header: "Application", width: 160 },
    { id: "Service", header: "Service", width: 180 },
    { id: "Department Tag", header: "Department tag", width: 160 },
] as const;

/** The report's own Azure page: the whole solution's cost, and how much of it is models. */
function SolutionView({ filters, prefix }: { filters: readonly string[]; prefix: string }) {
    const summary = useConsumptionSummary(azureSolutionSummary(), filters);
    const dailySource = azureSolutionDaily();
    const daily = useConsumptionTable(dailySource, filters);
    const byServiceSource = azureSolutionByService();
    const byService = useConsumptionTable(byServiceSource, filters);
    const resources = useConsumptionTable(azureSolutionResources(), filters);
    const row = summary.row;

    return (
        <>
            <KpiRowState
                summary={summary}
                count={10}
                className={KPI_GRID}
                emptyTitle="No Azure cost"
                emptyDescription="The Azure cost export has no rows for this cost basis."
            >
                <KpiCard
                    label="Azure cost"
                    value={readNumber(row, "[Selected Cost]")}
                    format="money"
                    prefix={prefix}
                    emphasis
                    detail={readText(row, "[Spend Context]")}
                />
                <KpiCard label="Model share" value={readNumber(row, "[Model Share]")} format="percent" detail="Of the solution's cost" />
                <KpiCard label="Supporting cost" value={readNumber(row, "[Supporting Cost]")} format="money" prefix={prefix} />
                <KpiCard label="AI requests" value={readNumber(row, "[AI Requests]")} />
                <KpiCard
                    label="Tagged allocation"
                    value={readNumber(row, "[Tagged Allocation]")}
                    format="percent"
                    detail="Cost with a department tag"
                />
                <KpiCard label="Tokens" value={readNumber(row, "[Tokens M]")} format="millions" />
                <KpiCard label="Speech hours" value={readNumber(row, "[Speech Hours]")} format="hours" />
                <KpiCard label="Document pages" value={readNumber(row, "[Document Pages]")} />
                <KpiCard label="Generated images" value={readNumber(row, "[Generated Images]")} />
                <KpiCard label="Cost per 1M tokens" value={readNumber(row, "[Cost Per 1M Tokens]")} format="money" prefix={prefix} />
            </KpiRowState>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
                <ChartPanel
                    result={daily}
                    spec={dailySource.vegaLiteSpec}
                    height={340}
                    title="Azure cost over time"
                    subtitle="Each day's cost: models, AI services, then the resources that support them"
                    emptyTitle="No daily cost"
                    emptyDescription="The Azure cost export has no days for this cost basis."
                />
                <ChartPanel
                    result={byService}
                    spec={byServiceSource.vegaLiteSpec}
                    height={Math.max(340, itemChartHeight(byService))}
                    title="Cost by service"
                    subtitle="The Azure services behind the solution"
                    emptyTitle="No service cost"
                    emptyDescription="No Azure service has cost for this cost basis."
                />
            </div>

            <ResourceGrid
                result={resources}
                prefix={prefix}
                labels={SOLUTION_LABELS}
                title="Azure resources"
                subtitle="Each resource's cost, and the department its tags allocate it to"
            />
        </>
    );
}

/**
 * The report's Azure page. It reads the whole-solution cost export when one
 * is loaded, and otherwise the Foundry model spend, so there is always
 * something to see.
 */
export function AzureStage({ options }: { options: ConsumptionOptions | undefined }) {
    const source = useConsumptionSummary(azureSource());
    const mode = useMemo(() => azureMode(source.row), [source.row]);
    const [basis, setBasis] = useState<string>();
    const [currency, setCurrency] = useState<string>();

    const bases = useMemo(() => options?.costBases ?? [], [options?.costBases]);
    const currencies = mode.kind === "solution" ? mode.currencies : [];
    const activeBasis = basis ?? bases[0];
    const activeCurrency = currency ?? currencies[0];

    // Actual and amortized rows describe the same spend, so one basis is always picked.
    const filters = useMemo(
        () => [
            ...(activeBasis ? [costBasisFilter(activeBasis)] : []),
            ...(currencies.length > 1 && activeCurrency ? [azureCurrencyFilter(activeCurrency)] : []),
        ],
        [activeBasis, activeCurrency, currencies.length],
    );

    const actions =
        mode.kind === "solution" && (bases.length > 1 || currencies.length > 1) ? (
            <div className="flex flex-wrap items-center gap-200">
                {currencies.length > 1 && activeCurrency && (
                    <SegmentedControl
                        label="Currency"
                        options={currencies.map((id) => ({ id, label: id }))}
                        value={activeCurrency}
                        onChange={setCurrency}
                    />
                )}
                {bases.length > 1 && activeBasis && (
                    <SegmentedControl
                        label="Cost basis"
                        options={bases.map((id) => ({ id, label: id }))}
                        value={activeBasis}
                        onChange={setBasis}
                    />
                )}
            </div>
        ) : undefined;

    return (
        <Section
            id={stageAnchor("azure-spend")}
            title="Azure"
            description={
                mode.kind === "solution"
                    ? "What the Azure side of the solution costs, and how much of it is AI models."
                    : "What the AI models behind your agents cost in Azure."
            }
            actions={actions}
        >
            {source.error !== undefined ? (
                <QueryError message={source.error} onRetry={source.refetch} />
            ) : !source.loaded ? (
                <div className={KPI_GRID}>
                    {Array.from({ length: 5 }, (_, index) => (
                        <QueryLoading key={index} />
                    ))}
                </div>
            ) : mode.kind === "solution" ? (
                <SolutionView filters={filters} prefix={currencyPrefix(activeCurrency)} />
            ) : mode.kind === "foundry" ? (
                <FoundryView currency={mode.currency} />
            ) : (
                <QueryEmpty
                    title="No Azure cost loaded"
                    description="Consumption Central has neither a whole-solution Azure cost export nor Foundry model spend. Load either one to fill this section."
                />
            )}
        </Section>
    );
}
