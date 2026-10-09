//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { stageAnchor } from "@/components/destinations";
import { QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { budgetRunway, runwayHeadline, shortDate, spreadWeeks, type Runway, type RunwayStatus } from "@/lib/budget-runway";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, type SummaryRow } from "@/lib/summary-row";
import { cn } from "@/lib/utils";
import {
    azureCurrencyFilter,
    azureSolutionDaily,
    costBasisFilter,
    coworkWeekly,
    currencyPrefix,
    foundryDaily,
    studioDaily,
    type AzureMode,
    type ConsumptionOptions,
} from "@/queries/consumption";
import { azureDailySpend, coworkWeeklySpend, earlierDate, studioDailySpend } from "./budget-series";
import { CREDIT_CURRENCY, SMALL, useConsumptionTable, type TableResult } from "./data";

const STATUS_LABEL: Record<RunwayStatus, string> = {
    "no-data": "No data",
    "no-budget": "No budget",
    early: "Too early",
    "on-track": "On track",
    "at-risk": "At risk",
    over: "Over budget",
};

const STATUS_TONE: Record<RunwayStatus, string> = {
    "no-data": "text-muted-foreground",
    "no-budget": "text-muted-foreground",
    early: "text-muted-foreground",
    "on-track": "text-positive",
    "at-risk": "text-caution",
    over: "text-negative",
};

const BAR_TONE: Record<RunwayStatus, string> = {
    "no-data": "bg-muted-foreground",
    "no-budget": "bg-muted-foreground",
    early: "bg-primary",
    "on-track": "bg-positive",
    "at-risk": "bg-caution",
    over: "bg-negative",
};

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

/** An empty query never runs, so a series that can't be read yet waits rather than reading the wrong rows. */
function waiting<T extends { query: string }>(source: T, ready: boolean): T {
    return ready ? source : { ...source, query: "" };
}

interface RunwayCardProps {
    label: string;
    result: TableResult;
    /** The source holds no rows at all, so there's nothing to wait for. */
    empty: boolean;
    runway: Runway;
    prefix: string;
    /** The day the source last has data for is only known to the week. */
    weekly?: boolean;
}

/** One product's month: spent so far against its budget, and where the month ends at this pace. */
function RunwayCard({ label, result, empty, runway, prefix, weekly }: RunwayCardProps) {
    const status: RunwayStatus = empty ? "no-data" : runway.status;
    const shown = empty ? { ...runway, status } : runway;
    const budget = runway.budget;
    const share = budget ? Math.min(1, runway.spent / budget) : 0;
    const projectedShare = budget && runway.projected !== undefined ? Math.min(1, runway.projected / budget) : 0;

    return (
        <article className="flex flex-col gap-300 rounded-xl border border-border bg-card p-500" aria-label={`${label} budget runway`}>
            <div className="flex items-baseline justify-between gap-200">
                <h3 className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground">{label}</h3>
                {!result.isLoading && result.error === undefined && (
                    <span className={cn(SMALL, "font-semibold", STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
                )}
            </div>
            {result.error !== undefined && !empty ? (
                <QueryError className="min-h-[160px]" message={result.error} onRetry={result.refetch} />
            ) : result.isLoading && !empty ? (
                <QueryLoading className="min-h-[160px]" />
            ) : (
                <>
                    <div className="flex flex-col gap-100">
                        <span className="font-numeric text-[length:var(--text-hero-800)] leading-hero-800 font-semibold tabular-nums text-card-foreground">
                            {formatKpi(status === "no-data" ? undefined : runway.spent, "currency", { prefix })}
                        </span>
                        <span className={cn(SMALL, "text-muted-foreground")}>
                            {budget
                                ? `spent this month, of ${formatKpi(budget, "currency", { prefix })}`
                                : status === "no-data"
                                  ? "spent this month"
                                  : "spent this month, no budget set"}
                        </span>
                    </div>
                    {budget !== undefined && status !== "no-data" && (
                        <div aria-hidden="true" className="relative h-200 overflow-hidden rounded-full bg-muted">
                            {projectedShare > share && (
                                <div
                                    className={cn("absolute inset-y-0 left-0 rounded-full opacity-30", BAR_TONE[status])}
                                    style={{ width: `${projectedShare * 100}%` }}
                                />
                            )}
                            <div
                                className={cn("absolute inset-y-0 left-0 rounded-full", BAR_TONE[status])}
                                style={{ width: `${share * 100}%` }}
                            />
                        </div>
                    )}
                    <p className="text-[length:var(--text-300)] leading-300 text-foreground">{runwayHeadline(shown, prefix, weekly)}</p>
                    {status !== "no-data" && runway.asOf && (
                        <p className={cn(SMALL, "border-t border-border pt-200 text-muted-foreground")}>
                            {weekly ? `Weekly data, spread over each week, to ${shortDate(runway.asOf)}.` : `Data to ${shortDate(runway.asOf)}.`}
                        </p>
                    )}
                </>
            )}
        </article>
    );
}

interface BudgetRunwayStageProps {
    options: ConsumptionOptions | undefined;
    /** Which Azure source the page reads, and so which series the Azure budget is tracked against. */
    azure: AzureMode;
    /** Row counts per product, so an empty source shows as empty rather than loading. */
    sources: SummaryRow | undefined;
}

/**
 * This month's spend against each product's monthly budget, and where the
 * month ends if the rest of it goes at the same daily pace. It always reads
 * the latest month in the data, whatever dates the page shows.
 */
export function BudgetRunwayStage({ options, azure, sources }: BudgetRunwayStageProps) {
    const { saved } = useCommercialTerms();
    const studioBudget = saved?.budgetStudio ?? undefined;
    const coworkBudget = saved?.budgetCowork ?? undefined;
    const azureBudget = saved?.budgetAzure ?? undefined;

    const studio = useConsumptionTable(studioDaily("cost"));
    const cowork = useConsumptionTable(coworkWeekly("cost"));

    const basis = options?.costBases[0];
    const currencies = azure.kind === "solution" ? azure.currencies : [];
    const firstCurrency = currencies.length > 1 ? currencies[0] : undefined;
    const azureFilters = useMemo(
        () => [...(basis ? [costBasisFilter(basis)] : []), ...(firstCurrency ? [azureCurrencyFilter(firstCurrency)] : [])],
        [basis, firstCurrency],
    );
    // Actual and amortized rows describe the same spend, so the solution feed waits for a basis.
    const solution = useConsumptionTable(
        waiting(azureSolutionDaily(), azure.kind === "solution" && options !== undefined),
        azureFilters,
    );
    const foundry = useConsumptionTable(waiting(foundryDaily(), azure.kind === "foundry"));
    const azureResult = azure.kind === "foundry" ? foundry : solution;
    const azureCurrency = azure.kind === "solution" ? currencies[0] : azure.kind === "foundry" ? azure.currency : undefined;
    const azurePrefix = currencyPrefix(azureCurrency);

    const studioRunway = useMemo(() => budgetRunway(studioDailySpend(studio.table), studioBudget), [studio.table, studioBudget]);
    const coworkRunway = useMemo(() => {
        const days = spreadWeeks(coworkWeeklySpend(cowork.table));
        const last = days.reduce<string | undefined>((latest, day) => (!latest || day.date > latest ? day.date : latest), undefined);
        // The last week is spread to its seventh day, which may not have happened yet.
        return budgetRunway(days, coworkBudget, earlierDate(last, todayIso()));
    }, [cowork.table, coworkBudget]);
    const azureRunway = useMemo(() => budgetRunway(azureDailySpend(azureResult.table), azureBudget), [azureResult.table, azureBudget]);

    const hasRows = (column: string) => (readNumber(sources, column) ?? 0) > 0;
    const known = sources !== undefined;

    return (
        <Section
            id={stageAnchor("budget-runway")}
            title="Budget runway"
            description="This month's spend against the monthly budgets set under Monthly budgets, and where the month ends at the same daily pace. It reads the latest month in the data, whatever dates are chosen, in the currency each product is billed in."
        >
            <div className="grid gap-300 md:grid-cols-3">
                <RunwayCard
                    label="Cowork / Work IQ"
                    result={cowork}
                    empty={known && !hasRows("[Cowork Rows]")}
                    runway={coworkRunway}
                    prefix={CREDIT_CURRENCY}
                    weekly
                />
                <RunwayCard
                    label="Copilot Studio"
                    result={studio}
                    empty={known && !hasRows("[Studio Rows]")}
                    runway={studioRunway}
                    prefix={CREDIT_CURRENCY}
                />
                <RunwayCard
                    label={azureCurrency ? `Azure (${azureCurrency})` : "Azure"}
                    result={azureResult}
                    empty={azure.kind === "none" || (known && !hasRows("[Azure Rows]"))}
                    runway={azureRunway}
                    prefix={azurePrefix}
                />
            </div>
            <p className={cn(SMALL, "max-w-[68ch] text-muted-foreground")}>
                The month-end figure is a straight line from the average day so far, not a forecast.
                {basis ? ` Azure uses the ${basis.toLowerCase()} cost basis.` : ""}
            </p>
        </Section>
    );
}
