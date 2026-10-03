//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { fabricConfig } from "@/fabric.generated";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { useConsumptionSummary, useConsumptionTable } from "@/hooks/use-consumption-query";
import { useSummaryQuery, useTableQuery, type TableResult } from "@/hooks/use-table-query";
import { useValueAssumptions, type Scenario } from "@/hooks/value-assumptions.context";
import { isConnectionConfigured } from "@/lib/connections";
import { dateBetween, treatAs } from "@/lib/dax-filters";
import { FILTER_KEYS, type FilterKey } from "@/lib/filters";
import { readNumber, readText } from "@/lib/summary-row";
import {
    consumptionByProduct,
    consumptionDates,
    consumptionNotes,
    coworkWindowCost,
    groupByFilter,
    isoDate,
    LICENSE_LIST_PRICE,
    reportingDateFilter,
    studioAgents,
} from "@/queries/consumption";
import { consumptionConnection } from "@/queries/shared";
import {
    compare,
    costValueAgents,
    costValueBySource,
    costValueWindow,
    isDollar,
    licenceCost,
    matchAgents,
    overlapSpan,
    pairLines,
    readAgentCredits,
    readAgentValues,
    readSourceValues,
    toValueCurrency,
    type AgentMatch,
    type Comparison,
    type Costs,
    type DateSpan,
    type PairId,
    type PairLine,
} from "@/queries/value";

/** Costs are tenant-wide, so only the date filter narrows this stage. */
export const COST_IGNORED_FILTERS: readonly FilterKey[] = FILTER_KEYS.filter((key) => key !== "dateRange");

/** Whether `fabric.yaml` sets up Consumption Central, where the credit costs come from. */
export const CONSUMPTION_CONFIGURED = isConnectionConfigured(fabricConfig.semanticModels, consumptionConnection);

/**
 * Whether the credit costs can be counted: Consumption Central isn't set up
 * (`off`), is still answering, couldn't be read, holds dates that miss the
 * activity entirely (`apart`), or is `ready`.
 */
export type CreditsState =
    | { kind: "off" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "apart"; held: DateSpan | undefined }
    | { kind: "ready" };

const STUDIO = /studio/i;
const AZURE = /azure|foundry/i;

function productCost(table: DataTable | undefined, pattern: RegExp): number | undefined {
    if (!table) return undefined;
    const product = table.columns.findIndex((column) => column.name === "Product");
    const cost = table.columns.findIndex((column) => column.name === "Cost");
    const row = table.rows.find((candidate) => pattern.test(String(candidate[product] ?? "")));
    const value = row?.[cost];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumKnown(parts: readonly (number | undefined)[]): number | undefined {
    const known = parts.filter((part): part is number => part !== undefined);
    return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

const SKIP = { connection: "", query: "" };

export interface CostVsValue {
    rate: number;
    scenario: Scenario;
    /** The value's currency symbol, as the model shows it. */
    symbol: string;
    /** Whether that is the US dollar, so costs need no exchange rate. */
    dollar: boolean;
    /** The value currency per US dollar, when one is set. */
    exchangeRate: number | undefined;
    /** Whether a cost in dollars can be set against value: the value is in dollars or a rate is set. */
    convertible: boolean;
    /** The days compared, once known. */
    span: DateSpan | undefined;
    /** The days ValueLens holds activity for inside the date filter, once known. */
    activity: DateSpan | undefined;
    credits: CreditsState;
    users: number | undefined;
    licencePrice: number;
    /** Whether the licence price is the US list price because none is saved. */
    listPrice: boolean;
    /** Each cost in US dollars, as billed. */
    usd: { licences: number | undefined; studio: number | undefined; cowork: number | undefined; total: number | undefined };
    /** Each cost in the value's currency, undefined until it can be converted. */
    costs: Costs;
    comparison: Comparison;
    pairs: PairLine[];
    agents: AgentMatch;
    azure: { cost: number | undefined; currency: string | undefined };
    /** The headline figures and the products comparison. */
    summary: TableResult;
    /** The agents comparison. */
    agentResult: TableResult;
}

/**
 * Everything the Cost vs value stage reads: the activity's dates, licences and
 * currency from ValueLens, value by source and by agent over the dates both
 * models hold, and the credit costs from Consumption Central.
 */
export function useCostVsValue(): CostVsValue {
    const { rate, scenario } = useValueAssumptions();
    const terms = useCommercialTerms();

    const windowSource = costValueWindow();
    const activityWindow = useSummaryQuery(windowSource, [], COST_IGNORED_FILTERS);
    const firstActivity = isoDate(activityWindow.row?.["[First Date]"]);
    const lastActivity = isoDate(activityWindow.row?.["[Last Date]"]);
    const activity = useMemo(
        () => (firstActivity && lastActivity ? { from: firstActivity, to: lastActivity } : undefined),
        [firstActivity, lastActivity],
    );
    const symbol = readText(activityWindow.row, "[Currency Symbol]") ?? "";
    const users = readNumber(activityWindow.row, "[Licensed Users]");

    const dates = useConsumptionSummary(CONSUMPTION_CONFIGURED ? consumptionDates() : { ...consumptionDates(), ...SKIP });
    const firstCredit = isoDate(dates.row?.["[First Date]"]);
    const lastCredit = isoDate(dates.row?.["[Last Date]"]);
    const held = useMemo(
        () => (firstCredit && lastCredit ? { from: firstCredit, to: lastCredit } : undefined),
        [firstCredit, lastCredit],
    );

    const overlap = useMemo(() => overlapSpan(activity, held), [activity, held]);
    const credits: CreditsState = !CONSUMPTION_CONFIGURED
        ? { kind: "off" }
        : dates.error !== undefined
          ? { kind: "error", message: dates.error }
          : !dates.loaded
            ? { kind: "loading" }
            : overlap
              ? { kind: "ready" }
              : { kind: "apart", held };
    const span = credits.kind === "ready" ? overlap : credits.kind === "loading" ? undefined : activity;
    const ready = credits.kind === "ready";

    const valueExtra = useMemo(
        () =>
            span
                ? [treatAs("'Hourly Value'[Hourly Value]", [rate]), dateBetween("'Calendar'[Date]", span.from, span.to)]
                : [],
        [rate, span],
    );
    const agentExtra = useMemo(
        () => (span ? [...valueExtra, treatAs("'Effort Scenario'[Scenario]", [scenario])] : []),
        [valueExtra, scenario, span],
    );
    const bySourceSource = costValueBySource();
    const bySource = useTableQuery(
        span ? bySourceSource : { ...bySourceSource, query: "" },
        valueExtra,
        COST_IGNORED_FILTERS,
    );
    const agentValueSource = costValueAgents();
    const agentValues = useTableQuery(
        span && ready ? agentValueSource : { ...agentValueSource, query: "" },
        agentExtra,
        COST_IGNORED_FILTERS,
    );

    const creditExtra = useMemo(() => (ready && span ? [reportingDateFilter(span.from, span.to)] : []), [ready, span]);
    const byProductSource = consumptionByProduct();
    const byProduct = useConsumptionTable(ready ? byProductSource : { ...byProductSource, ...SKIP }, creditExtra);
    const coworkSource = coworkWindowCost();
    const coworkCost = useConsumptionSummary(ready ? coworkSource : { ...coworkSource, ...SKIP }, creditExtra);
    const notes = useConsumptionSummary(ready ? consumptionNotes() : { ...consumptionNotes(), ...SKIP }, creditExtra);
    const studioSource = studioAgents();
    const agentExtraCredits = useMemo(() => [groupByFilter(undefined)], []);
    const agentCredits = useConsumptionTable(ready ? studioSource : { ...studioSource, ...SKIP }, agentExtraCredits);

    const saved = terms.saved;
    const licencePrice = saved?.licensePrice ?? LICENSE_LIST_PRICE;
    const exchangeRate = saved?.exchangeRate;
    const dollar = isDollar(symbol);

    const usd = useMemo(() => {
        const licences = users !== undefined && span ? licenceCost(users, licencePrice, span) : undefined;
        const studio = ready ? productCost(byProduct.table, STUDIO) : undefined;
        const cowork = ready ? readNumber(coworkCost.row, "[Cost]") : undefined;
        return { licences, studio, cowork, total: sumKnown([licences, studio, cowork]) };
    }, [users, span, licencePrice, ready, byProduct.table, coworkCost.row]);

    const costs = useMemo<Costs>(
        () => ({
            licences: toValueCurrency(usd.licences, symbol, exchangeRate),
            studio: toValueCurrency(usd.studio, symbol, exchangeRate),
            cowork: toValueCurrency(usd.cowork, symbol, exchangeRate),
        }),
        [usd, symbol, exchangeRate],
    );

    const sourceValues = useMemo(() => readSourceValues(bySource.table), [bySource.table]);
    const comparison = useMemo(() => compare(sourceValues, costs, scenario, rate), [sourceValues, costs, scenario, rate]);
    const pairIds = useMemo<PairId[]>(() => (ready ? ["licences", "studio", "cowork"] : ["licences"]), [ready]);
    const pairs = useMemo(() => pairLines(sourceValues, costs, scenario, pairIds), [sourceValues, costs, scenario, pairIds]);
    const agents = useMemo(
        () => matchAgents(readAgentValues(agentValues.table), readAgentCredits(agentCredits.table), costs.studio),
        [agentValues.table, agentCredits.table, costs.studio],
    );

    // A skipped query keeps its last result, so its error counts only while it runs.
    const summaryError =
        activityWindow.error ??
        (span ? bySource.error : undefined) ??
        (ready ? (byProduct.error ?? coworkCost.error) : undefined);
    const summaryLoading =
        summaryError === undefined &&
        (!activityWindow.loaded ||
            terms.status === "loading" ||
            credits.kind === "loading" ||
            (activity !== undefined && !bySource.table) ||
            (ready && (!byProduct.table || !coworkCost.loaded)));
    const summary: TableResult = {
        table: bySource.table,
        error: summaryError,
        isLoading: summaryLoading,
        refetch: () => {
            activityWindow.refetch();
            if (span) bySource.refetch();
            if (ready) {
                byProduct.refetch();
                coworkCost.refetch();
            }
        },
    };
    const agentError = ready ? ((span ? agentValues.error : undefined) ?? agentCredits.error) : undefined;
    const agentResult: TableResult = {
        table: agentValues.table,
        error: agentError,
        isLoading: agentError === undefined && (summaryLoading || !agentValues.table || !agentCredits.table),
        refetch: () => {
            agentValues.refetch();
            agentCredits.refetch();
        },
    };

    return {
        rate,
        scenario,
        symbol,
        dollar,
        exchangeRate,
        convertible: dollar || exchangeRate !== undefined,
        span,
        activity,
        credits,
        users,
        licencePrice,
        listPrice: saved?.licensePrice === undefined,
        usd,
        costs,
        comparison,
        pairs,
        agents,
        azure: { cost: ready ? productCost(byProduct.table, AZURE) : undefined, currency: readText(notes.row, "[Azure Currency]") },
        summary,
        agentResult,
    };
}
