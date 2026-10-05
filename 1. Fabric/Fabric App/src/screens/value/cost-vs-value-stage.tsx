//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { FilterMenu } from "@/components/filter-menu";
import { FilterNote } from "@/components/filter-note";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { ChartPanel, NoteCard, Panel, type Note } from "@/components/report-panels";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { TermsForm, type TermField } from "@/components/terms-form";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { useThemeContext } from "@/hooks/theme.context";
import { SCENARIOS, useValueAssumptions } from "@/hooks/value-assumptions.context";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { formatDateRange } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { LICENSE_LIST_PRICE } from "@/queries/consumption";
import { agentTable, costValueSpec, pairTable, spanDays, spanMonths, type DateSpan } from "@/queries/value";
import { COST_IGNORED_FILTERS, useCostVsValue, type CostVsValue } from "./cost-vs-value-data";

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function returnCell(value: unknown) {
    const ratio = asNumber(value);
    if (ratio === undefined) return null;
    // Red whenever cost outruns value; formatKpi keeps any such figure below 1.0×.
    const below = ratio < 1;
    return <span className={below ? "text-destructive" : undefined}>{formatKpi(ratio, "multiple")}</span>;
}

function amountCell(prefix: string, format: "currency" | "money") {
    return (value: unknown) => {
        const amount = asNumber(value);
        return amount === undefined ? null : formatKpi(amount, format, { prefix });
    };
}

function wholeCell(value: unknown) {
    const n = asNumber(value);
    return n === undefined ? null : formatKpi(n, "whole");
}

function percentCell(value: unknown) {
    const n = asNumber(value);
    return n === undefined ? null : formatKpi(n, "percent");
}

const dollars = (value: number, digits = 0) =>
    `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

function rangeText(span: DateSpan): string {
    const days = spanDays(span);
    return `${formatDateRange(span.from, span.to)} (${days} ${days === 1 ? "day" : "days"})`;
}

/** Why the credit costs are, or aren't, in the comparison. */
function creditsNote(data: CostVsValue): string {
    switch (data.credits.kind) {
        case "ready":
            return "Copilot Studio and Cowork / Work IQ, from Consumption Central at the rates set under Rates & packs on the Consumption page. Cowork credits use the Capacity Pack first, at the prepaid rate, then pay-as-you-go, as on the Consumption page's Cowork section. Unused pack credits aren't counted.";
        case "off":
            return "Not counted: Consumption Central isn't set up for this app, so the cost is licences alone and the return reads high.";
        case "apart":
            return data.credits.held
                ? `Not counted: Consumption Central holds ${formatDateRange(data.credits.held.from, data.credits.held.to)}, which doesn't overlap the activity. The cost is licences alone, so the return reads high.`
                : "Not counted: Consumption Central holds no dated credits yet. The cost is licences alone, so the return reads high.";
        case "error":
            return `Not counted: Consumption Central couldn't be read (${data.credits.message}). The cost is licences alone, so the return reads high.`;
        case "loading":
            return "Reading Consumption Central…";
    }
}

function howNotes(data: CostVsValue): Note[] {
    const { span, symbol, rate, scenario, users, licencePrice, listPrice, credits, azure, dollar, exchangeRate } = data;
    const counted = credits.kind === "ready";
    return [
        {
            term: "Dates",
            text: span
                ? `${rangeText(span)}: the days ${counted ? "both ValueLens and Consumption Central hold" : "ValueLens holds activity for"}, inside the date filter.`
                : undefined,
        },
        {
            term: "Licences",
            text:
                span && users !== undefined
                    ? `${formatKpi(users, "whole")} licensed users × ${dollars(licencePrice, 2)} a month${listPrice ? " (the US list price)" : ""} × ${spanMonths(span).toFixed(1)} months.`
                    : undefined,
        },
        { term: "Credits", text: creditsNote(data) },
        {
            term: "Value",
            text: `Expert-equivalent hours at ${symbol}${formatKpi(rate, "whole")} an hour, ${scenario.toLowerCase()} effort. The rate is set under Estimated value; the scenario here or there. The range under Return uses the conservative and optimistic scenarios at the same rate.`,
        },
        {
            term: "Pairing",
            text: counted
                ? "Licences pay for licensed users' Copilot chat and apps, Copilot Studio credits for agents, and Cowork credits for Cowork. Agents' value also covers built-in and Agent Builder agents a licence pays for, so that pair reads high."
                : "Licences are set against licensed users' Copilot chat and apps.",
        },
        {
            term: "Left out",
            text: `${
                data.comparison.unlicensedChat !== undefined && data.comparison.unlicensedChat > 0
                    ? `Copilot Chat by people without a licence (${formatKpi(data.comparison.unlicensedChat, "currency", { prefix: symbol })} of value), as it's free with Microsoft 365 and no cost here pays for it. `
                    : ""
            }${
                azure.cost !== undefined
                    ? `Azure AI Foundry (${formatKpi(azure.cost, "money", { prefix: azure.currency === "USD" || !azure.currency ? "$" : `${azure.currency} ` })} over these dates), as ValueLens doesn't record the work it does. `
                    : "Azure AI Foundry, as ValueLens doesn't record the work it does. "
            }GitHub Copilot, which neither model holds. Filters other than dates, as costs aren't split that way.`,
        },
        {
            term: "Exchange rate",
            text: dollar
                ? undefined
                : exchangeRate !== undefined
                  ? `$1 = ${symbol}${exchangeRate}, set under Prices. Licences and credits are billed in US dollars.`
                  : `Not set. Licences and credits are billed in US dollars, so set how many ${symbol || "units of the value's currency"} make $1 under Prices.`,
        },
    ];
}

function agentNotes(data: CostVsValue): Note[] {
    const { symbol, rate, scenario, costs, agents } = data;
    const studio = costs.studio !== undefined ? ` (${formatKpi(costs.studio, "currency", { prefix: symbol })})` : "";
    return [
        {
            term: "Cost",
            text: `Copilot Studio's cost over these dates${studio}, split by each agent's share of all the Copilot Studio credits Consumption Central holds by agent.`,
        },
        {
            term: "Value",
            text: `The work ValueLens records for the agent with the same name, at ${symbol}${formatKpi(rate, "whole")} an hour, ${scenario.toLowerCase()} effort.`,
        },
        {
            term: "Not found",
            text:
                agents.unmatched.length > 0
                    ? `${agents.unmatched.join(", ")}: no activity under that name in ValueLens over these dates, so ${agents.unmatched.length === 1 ? "its" : "their"} share isn't set against any value.`
                    : undefined,
        },
    ];
}

/**
 * The prices the comparison's costs are worked out at, set for everyone who
 * opens the app: the licence price and, when value isn't in dollars, the
 * exchange rate.
 */
function PricesMenu({ data }: { data: CostVsValue }) {
    const { status } = useCommercialTerms();
    const { dollar, symbol, listPrice, exchangeRate } = data;
    const fields = useMemo<TermField[]>(() => {
        const list: TermField[] = [
            {
                key: "licensePrice",
                label: "Microsoft 365 Copilot licence",
                hint: `$ per user per month. Empty uses the ${dollars(LICENSE_LIST_PRICE)} US list price.`,
                placeholder: String(LICENSE_LIST_PRICE),
                inputMode: "decimal",
            },
        ];
        if (!dollar) {
            list.push({
                key: "exchangeRate",
                label: "Exchange rate",
                hint: `${symbol || "Value currency"} per $1, to set dollar costs against value.`,
                inputMode: "decimal",
            });
        }
        return list;
    }, [dollar, symbol]);

    const needsRate = !dollar && exchangeRate === undefined;
    const summary =
        status === "loading" ? "Loading…" : needsRate ? "Exchange rate needed" : listPrice ? "List price" : "Set in this app";

    return (
        <FilterMenu label="Prices" summary={summary} active={!listPrice || exchangeRate !== undefined} panelClassName="w-[320px]">
            {(close) => (
                <TermsForm
                    fields={fields}
                    intro="Microsoft 365 Copilot licences and Copilot credits are billed in US dollars."
                    resetLabel="Use defaults"
                    unavailableText="Prices can't be saved here right now, so the US list price applies."
                    note="They're used here only."
                    close={close}
                />
            )}
        </FilterMenu>
    );
}

const noop = () => {};

const scenarioOptions = SCENARIOS.map((id) => ({ id, label: id }));

/**
 * Stands in for the comparison until an exchange rate is set: the box to type
 * it in, right where the charts will appear.
 */
function RatePrompt({ symbol }: { symbol: string }) {
    const headingId = useId();
    const unit = symbol || "units of the value's currency";
    const fields = useMemo<TermField[]>(
        () => [
            {
                key: "exchangeRate",
                label: `${symbol || "Value currency"} per $1`,
                hint: `For example 0.75 if $1 buys ${symbol || ""}0.75.`,
                inputMode: "decimal",
            },
        ],
        [symbol],
    );
    return (
        <section
            aria-labelledby={headingId}
            className="flex flex-col gap-300 rounded-xl border border-dashed border-border bg-card p-500"
        >
            <h3 id={headingId} className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                Set an exchange rate to compare
            </h3>
            <div className="max-w-[360px]">
                <TermsForm
                    fields={fields}
                    intro={`Licences and credits are billed in US dollars and value is in ${symbol || "another currency"}. Type how many ${unit} make $1.`}
                    resetLabel="Clear"
                    unavailableText="The exchange rate can't be saved here right now."
                    note="It's also under Prices, above."
                    close={noop}
                />
            </div>
        </section>
    );
}

/**
 * Sets what Copilot cost over the dates against the estimated value of the
 * work it did: licences against licensed users' Copilot chat and apps, Copilot Studio credits
 * against agents, and Cowork credits against Cowork, at the rate chosen on
 * the Estimated value stage and the effort scenario shared with it.
 */
export function CostVsValueStage() {
    const data = useCostVsValue();
    const { setScenario } = useValueAssumptions();
    const { theme } = useThemeContext();
    const { symbol, rate, scenario, span, comparison, costs, usd, convertible, credits, summary, agents } = data;
    const counted = credits.kind === "ready";

    const products = useMemo(() => pairTable(data.pairs), [data.pairs]);
    const agentRows = useMemo(() => agentTable(agents.lines), [agents.lines]);
    const spec = useMemo(() => costValueSpec(symbol), [symbol]);

    const productColumns: GridColumnDef[] = useMemo(
        () => [
            { id: "Cost Line", header: "Cost", minWidth: 220 },
            // Each width fits its header beside the sort arrow, even with a three-letter currency code; the two text columns share the rest.
            {
                id: "Cost",
                header: `Cost (${symbol || "currency"})`,
                width: 108,
                numericStyling: true,
                cellRenderer: amountCell(symbol, "currency"),
            },
            { id: "Set Against", header: "Set against", minWidth: 180 },
            {
                id: "Value",
                header: `Estimated value (${symbol || "currency"})`,
                width: 168,
                numericStyling: true,
                cellRenderer: amountCell(symbol, "currency"),
            },
            { id: "Return", header: "Return", width: 96, numericStyling: true, cellRenderer: returnCell },
            { id: "Pair", header: "Pair", hidden: true },
            { id: "Sort", header: "Order", hidden: true },
        ],
        [symbol],
    );

    const agentColumns: GridColumnDef[] = useMemo(
        () => [
            { id: "Pair", header: "Agent", minWidth: 220 },
            { id: "Share", header: "Share of credits", width: 136, numericStyling: true, cellRenderer: percentCell },
            {
                id: "Cost",
                header: `Allocated cost (${symbol || "currency"})`,
                width: 168,
                numericStyling: true,
                cellRenderer: amountCell(symbol, "money"),
            },
            { id: "Sessions", header: "Sessions", width: 96, numericStyling: true, cellRenderer: wholeCell },
            {
                id: "Value",
                header: `Estimated value (${symbol || "currency"})`,
                width: 172,
                numericStyling: true,
                cellRenderer: heatRenderer({
                    domain: columnHeat(agentRows, "Value"),
                    format: (value) => amountCell(symbol, "currency")(value),
                }),
            },
            { id: "Return", header: "Return", width: 96, numericStyling: true, cellRenderer: returnCell },
            { id: "Sort", header: "Order", hidden: true },
        ],
        [symbol, agentRows],
    );

    const needRate = "Needs an exchange rate, set below.";
    const productsHeight = rowChartHeight(data.pairs.length, { perRow: 56, chrome: 140, min: 220 });
    const agentsChartHeight = rowChartHeight(agents.lines.length, { perRow: 40, chrome: 140, min: 240 });

    const body = (() => {
        if (summary.error !== undefined && !data.activity) {
            return <QueryError message={summary.error} onRetry={summary.refetch} />;
        }
        if (summary.isLoading && !data.activity) {
            return (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            );
        }
        if (!data.activity) {
            return (
                <QueryEmpty
                    title="No activity in these dates"
                    description="ValueLens holds no Copilot activity inside the date filter, so there's no value to set against cost."
                />
            );
        }
        return null;
    })();

    return (
        <Section
            id={stageAnchor("cost-vs-value")}
            title="Cost vs value"
            description="What Copilot cost over these dates, set against the estimated value of the work it did."
            actions={
                <div className="flex flex-wrap items-center gap-200">
                    <SegmentedControl label="Scenario" options={scenarioOptions} value={scenario} onChange={setScenario} />
                    <PricesMenu data={data} />
                </div>
            }
        >
            <FilterNote ignored={COST_IGNORED_FILTERS} reason="costs aren't recorded that way, so this compares the whole tenant." />

            {body ?? (
                <>
                    <p className={cn(SMALL, "text-muted-foreground")}>
                        {span ? `${formatDateRange(span.from, span.to)} · ` : ""}
                        {`At ${symbol}${formatKpi(rate, "whole")} an hour, as set under `}
                        <a
                            href={`#${stageAnchor("estimated-value")}`}
                            className="text-foreground underline underline-offset-2 hover:text-primary"
                        >
                            Estimated value
                        </a>
                        {`, ${scenario.toLowerCase()} effort`}
                        {!data.dollar && data.exchangeRate !== undefined ? ` · $1 = ${symbol}${data.exchangeRate}` : ""}
                    </p>

                    {summary.error !== undefined ? (
                        <QueryError message={summary.error} onRetry={summary.refetch} />
                    ) : summary.isLoading ? (
                        <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                            <QueryLoading />
                            <QueryLoading />
                            <QueryLoading />
                            <QueryLoading />
                        </div>
                    ) : (
                        <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                            <KpiCard
                                label="Return on cost"
                                value={comparison.ratio}
                                format="multiple"
                                emphasis
                                detail={
                                    !convertible ? (
                                        needRate
                                    ) : (
                                        <div className="flex flex-col gap-100">
                                            <KpiStat label="Conservative" value={comparison.low} format="multiple" />
                                            <KpiStat label="Optimistic" value={comparison.high} format="multiple" />
                                            {!counted && <span>Licences only: credits aren't counted.</span>}
                                        </div>
                                    )
                                }
                            />
                            <KpiCard
                                label="Estimated value"
                                value={comparison.value}
                                format="currency"
                                prefix={symbol}
                                detail={
                                    comparison.unlicensedChat !== undefined && comparison.unlicensedChat > 0
                                        ? `${scenario} effort at ${symbol}${formatKpi(rate, "whole")} an hour. Leaves out ${formatKpi(comparison.unlicensedChat, "currency", { prefix: symbol })} of free Copilot Chat by people without a licence.`
                                        : `${scenario} effort at ${symbol}${formatKpi(rate, "whole")} an hour`
                                }
                            />
                            {convertible ? (
                                <KpiCard
                                    label="Cost"
                                    value={comparison.cost}
                                    format="currency"
                                    prefix={symbol}
                                    detail={
                                        <div className="flex flex-col gap-100">
                                            <KpiStat label="Licences" value={costs.licences} format="currency" prefix={symbol} />
                                            {counted && (
                                                <KpiStat label="Credits" value={comparison.credits} format="currency" prefix={symbol} />
                                            )}
                                        </div>
                                    }
                                />
                            ) : (
                                <KpiCard
                                    label="Cost"
                                    value={usd.total}
                                    format="currency"
                                    prefix="$"
                                    detail={`In US dollars. ${needRate}`}
                                />
                            )}
                            <KpiCard
                                label="Break-even hourly rate"
                                value={comparison.breakEvenRate}
                                format="money"
                                prefix={symbol}
                                detail={
                                    convertible
                                        ? `The value covers the cost at any rate above this, ${scenario.toLowerCase()} effort.`
                                        : needRate
                                }
                            />
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                        {convertible ? (
                            <div className="flex min-w-0 flex-col gap-300">
                                <ChartPanel
                                    result={summary}
                                    table={products}
                                    spec={spec}
                                    height={productsHeight}
                                    title="Each cost and the work it pays for"
                                    subtitle={`Cost and estimated value, in ${symbol || "the value's currency"}`}
                                    emptyTitle="Nothing to compare"
                                    emptyDescription="There's no cost or value over these dates."
                                />
                                <Panel
                                    result={summary}
                                    table={products}
                                    height={gridHeight(data.pairs.length, { perRow: 52 })}
                                    emptyTitle="Nothing to compare"
                                    emptyDescription="There's no cost or value over these dates."
                                >
                                    {(table) => (
                                        <DataGrid
                                            columns={productColumns}
                                            data={table}
                                            theme={theme}
                                            header={{
                                                title: "Cost and value side by side",
                                                subtitle: "Below 1× the cost is more than the value it was set against.",
                                            }}
                                        />
                                    )}
                                </Panel>
                            </div>
                        ) : (
                            <div className="min-w-0">
                                <RatePrompt symbol={symbol} />
                            </div>
                        )}
                        <NoteCard title="How this is worked out" notes={howNotes(data)} />
                    </div>

                    {counted && convertible && (
                        <div className="flex flex-col gap-300">
                            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                                <div className="min-w-0">
                                    <ChartPanel
                                        result={data.agentResult}
                                        table={agentRows}
                                        spec={spec}
                                        height={agentsChartHeight}
                                        title="Copilot Studio agents"
                                        subtitle="Each agent's share of the credit cost and the value of its work"
                                        emptyTitle="No agents found by name"
                                        emptyDescription="None of the agents with Copilot Studio credits has activity under the same name in ValueLens over these dates."
                                    />
                                </div>
                                <div className="xl:self-start">
                                    <NoteCard title="How agents are costed" notes={agentNotes(data)} />
                                </div>
                            </div>
                            {agents.lines.length > 0 && (
                                <Panel
                                    result={data.agentResult}
                                    table={agentRows}
                                    height={gridHeight(agents.lines.length, { max: 520 })}
                                    emptyTitle="No agents found by name"
                                    emptyDescription="None of the agents with Copilot Studio credits has activity under the same name in ValueLens over these dates."
                                >
                                    {(table) => (
                                        <DataGrid
                                            columns={agentColumns}
                                            data={table}
                                            theme={theme}
                                            header={{
                                                title: "Agent cost and value",
                                                subtitle: `${agents.lines.length} of ${agents.total} Copilot Studio agents found in ValueLens by name`,
                                            }}
                                        />
                                    )}
                                </Panel>
                            )}
                        </div>
                    )}
                </>
            )}
        </Section>
    );
}
