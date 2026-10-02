//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_MONEY, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import agentsQuery from "./cost-vs-value-agents.dax?raw";
import bySourceQuery from "./cost-vs-value-by-source.dax?raw";
import windowQuery from "./cost-vs-value-window.dax?raw";
import costValueSpecTemplate from "./cost-vs-value.json";
import { SCENARIOS, type Scenario } from "./scenarios";

const windowColumns: ColumnMetadataMap = {
    "[First Date]": { name: "First Date", displayName: "First date" },
    "[Last Date]": { name: "Last Date", displayName: "Last date" },
    "[Licensed Users]": { name: "Licensed Users", displayName: "Licensed users", format: FORMAT_WHOLE },
    "[Currency Symbol]": { name: "Currency Symbol", displayName: "Currency symbol" },
};

/**
 * The dates with recorded activity after the date filter, the licensed users
 * and the value's currency: what the cost side is worked out over.
 */
export function costValueWindow() {
    return { connection, query: windowQuery, columnMetadata: windowColumns };
}

const bySourceColumns: ColumnMetadataMap = {
    "[Source]": { name: "Source", displayName: "Activity" },
    "[Scenario]": { name: "Scenario", displayName: "Scenario" },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Value]": { name: "Value", displayName: "Estimated value", format: FORMAT_WHOLE },
};

/**
 * Value by activity source under all three effort scenarios at once, so the
 * return can be given as a range. The hourly rate is applied outside, as on
 * the Estimated value stage; the scenario is iterated here instead.
 */
export function costValueBySource() {
    return { connection, query: bySourceQuery, columnMetadata: bySourceColumns };
}

const agentsColumns: ColumnMetadataMap = {
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Value]": { name: "Value", displayName: "Estimated value", format: FORMAT_WHOLE },
};

/** Every named agent with sessions, no top-N cut, so each Copilot Studio agent can be found by name. */
export function costValueAgents() {
    return { connection, query: agentsQuery, columnMetadata: agentsColumns };
}

/** An inclusive span of ISO `yyyy-mm-dd` dates. */
export interface DateSpan {
    from: string;
    to: string;
}

/** The dates both spans cover, or undefined when either is unknown or they don't meet. */
export function overlapSpan(a: DateSpan | undefined, b: DateSpan | undefined): DateSpan | undefined {
    if (!a || !b) return undefined;
    const from = a.from > b.from ? a.from : b.from;
    const to = a.to < b.to ? a.to : b.to;
    return from <= to ? { from, to } : undefined;
}

export function spanDays(span: DateSpan): number {
    return Math.round((Date.parse(`${span.to}T00:00:00Z`) - Date.parse(`${span.from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** An average calendar month, so a licence's monthly price can be spread over any run of days. */
export const DAYS_PER_MONTH = 365.25 / 12;

export function spanMonths(span: DateSpan): number {
    return spanDays(span) / DAYS_PER_MONTH;
}

/** What `users` licences cost over the span, in the price's currency. */
export function licenceCost(users: number, pricePerMonth: number, span: DateSpan): number {
    return users * pricePerMonth * spanMonths(span);
}

/** Whether the value's currency symbol is the US dollar, so dollar costs need no exchange rate. */
export function isDollar(symbol: string): boolean {
    return /^(\$|US\$|USD)$/i.test(symbol.trim());
}

/**
 * A US-dollar cost in the value's currency: as it is when that is dollars,
 * at the exchange rate otherwise, and undefined when there is no rate.
 */
export function toValueCurrency(usd: number | undefined, symbol: string, exchangeRate: number | undefined): number | undefined {
    if (usd === undefined) return undefined;
    if (isDollar(symbol)) return usd;
    return exchangeRate === undefined ? undefined : usd * exchangeRate;
}

function columnIndex(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

function numberIn(row: readonly unknown[], index: number): number | undefined {
    const value = index < 0 ? undefined : row[index];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textIn(row: readonly unknown[], index: number): string | undefined {
    const value = index < 0 ? undefined : row[index];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Each activity source's value under each scenario. */
export type SourceValues = ReadonlyMap<string, Partial<Record<Scenario, number>>>;

export function readSourceValues(table: DataTable | undefined): SourceValues {
    const values = new Map<string, Partial<Record<Scenario, number>>>();
    if (!table) return values;
    const [source, scenario, value] = ["Source", "Scenario", "Value"].map((name) => columnIndex(table, name));
    for (const row of table.rows) {
        const name = textIn(row, source);
        const which = textIn(row, scenario) as Scenario | undefined;
        if (!name || !which || !SCENARIOS.includes(which)) continue;
        const entry = values.get(name) ?? {};
        entry[which] = numberIn(row, value);
        values.set(name, entry);
    }
    return values;
}

/** Every source's value under one scenario, or undefined when none has any. */
export function scenarioValue(values: SourceValues, scenario: Scenario): number | undefined {
    let total: number | undefined;
    for (const entry of values.values()) {
        const value = entry[scenario];
        if (value !== undefined) total = (total ?? 0) + value;
    }
    return total;
}

function sum(parts: readonly (number | undefined)[]): number | undefined {
    const known = parts.filter((part): part is number => part !== undefined);
    return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

/** Value over cost, when both are known and there is a cost to cover. */
export function returnOn(value: number | undefined, cost: number | undefined): number | undefined {
    return value === undefined || cost === undefined || cost <= 0 ? undefined : value / cost;
}

/** Each cost in the value's currency. A credit cost is undefined when Consumption Central isn't set up. */
export interface Costs {
    licences: number | undefined;
    studio: number | undefined;
    cowork: number | undefined;
}

export interface Comparison {
    /** All recorded work under the chosen scenario. */
    value: number | undefined;
    /** Licences and credits. Undefined until the licences can be priced in the value's currency. */
    cost: number | undefined;
    credits: number | undefined;
    /** Value over cost, under the chosen scenario. */
    ratio: number | undefined;
    /** The return under the conservative and optimistic scenarios. */
    low: number | undefined;
    high: number | undefined;
    /** The hourly rate at which the chosen scenario's value would just cover the cost. */
    breakEvenRate: number | undefined;
}

/** The headline figures: value against licences and credits, at the chosen rate and scenario. */
export function compare(values: SourceValues, costs: Costs, scenario: Scenario, rate: number): Comparison {
    const credits = sum([costs.studio, costs.cowork]);
    const cost = costs.licences === undefined ? undefined : sum([costs.licences, credits]);
    const value = scenarioValue(values, scenario);
    const ratio = returnOn(value, cost);
    return {
        value,
        cost,
        credits,
        ratio,
        low: returnOn(scenarioValue(values, "Conservative"), cost),
        high: returnOn(scenarioValue(values, "Optimistic"), cost),
        breakEvenRate: ratio === undefined || ratio <= 0 ? undefined : rate / ratio,
    };
}

export type PairId = "licences" | "studio" | "cowork";

/** Each cost and the activity it pays for, as the model's Activity column names it. */
export const PAIRS: readonly { id: PairId; cost: string; source: string; value: string; chart: string }[] = [
    {
        id: "licences",
        cost: "Microsoft 365 Copilot licences",
        source: "Copilot",
        value: "Copilot chat and apps",
        chart: "Licences → Copilot chat and apps",
    },
    { id: "studio", cost: "Copilot Studio credits", source: "Agents", value: "Agents", chart: "Studio credits → Agents" },
    { id: "cowork", cost: "Cowork / Work IQ credits", source: "Cowork", value: "Cowork", chart: "Cowork credits → Cowork" },
];

export interface PairLine {
    id: PairId;
    cost: number | undefined;
    value: number | undefined;
    ratio: number | undefined;
}

/** Each cost beside the value of the activity it pays for, under the chosen scenario. */
export function pairLines(values: SourceValues, costs: Costs, scenario: Scenario, ids: readonly PairId[]): PairLine[] {
    return PAIRS.filter((pair) => ids.includes(pair.id)).map((pair) => {
        const cost = costs[pair.id];
        const value = values.get(pair.source)?.[scenario];
        return { id: pair.id, cost, value, ratio: returnOn(value, cost) };
    });
}

export const PAIR_TABLE_COLUMNS = ["Pair", "Cost Line", "Cost", "Set Against", "Value", "Return", "Sort"] as const;

/** The pairs as one table, for the grid and the cost-and-value chart alike. */
export function pairTable(lines: readonly PairLine[]): DataTable {
    return {
        columns: [
            { name: "Pair", displayName: "Pair" },
            { name: "Cost Line", displayName: "Cost" },
            { name: "Cost", displayName: "Cost", format: FORMAT_WHOLE },
            { name: "Set Against", displayName: "Set against" },
            { name: "Value", displayName: "Estimated value", format: FORMAT_WHOLE },
            { name: "Return", displayName: "Return", format: "0.0" },
            { name: "Sort", displayName: "Order", format: FORMAT_WHOLE },
        ],
        rows: lines.map((line, index) => {
            const pair = PAIRS.find((candidate) => candidate.id === line.id)!;
            return [pair.chart, pair.cost, line.cost ?? null, pair.value, line.value ?? null, line.ratio ?? null, index];
        }),
    };
}

export interface AgentValue {
    name: string;
    sessions: number | undefined;
    value: number | undefined;
}

export interface AgentCredits {
    name: string;
    credits: number;
}

export function readAgentValues(table: DataTable | undefined): AgentValue[] {
    if (!table) return [];
    const [agent, sessions, value] = ["Agent", "Sessions", "Value"].map((name) => columnIndex(table, name));
    return table.rows.flatMap((row) => {
        const name = textIn(row, agent);
        return name ? [{ name, sessions: numberIn(row, sessions), value: numberIn(row, value) }] : [];
    });
}

/** Each Copilot Studio agent's credits, from Consumption Central. */
export function readAgentCredits(table: DataTable | undefined): AgentCredits[] {
    if (!table) return [];
    const [agent, credits] = ["Agent", "Credits Used"].map((name) => columnIndex(table, name));
    return table.rows.flatMap((row) => {
        const name = textIn(row, agent);
        const used = numberIn(row, credits);
        return name && used !== undefined ? [{ name, credits: used }] : [];
    });
}

/** Agent names as both models might spell them: trimmed, single-spaced and case-blind. */
export function agentKey(name: string): string {
    return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface AgentLine {
    name: string;
    /** The agent's share of all the Copilot Studio credits held by agent. */
    share: number;
    /** Copilot Studio's cost over the dates, allocated by that share. */
    cost: number | undefined;
    sessions: number | undefined;
    value: number | undefined;
    ratio: number | undefined;
}

export interface AgentMatch {
    lines: AgentLine[];
    /** Copilot Studio agents with credits but no activity by that name in ValueLens over these dates. */
    unmatched: string[];
    /** Every Copilot Studio agent with credits. */
    total: number;
}

/**
 * Sets each Copilot Studio agent's share of the cost against the value of
 * the ValueLens agent with the same name. Credits by agent aren't dated, so
 * the cost over the dates is Copilot Studio's, split by each agent's share of
 * all the credits held by agent.
 */
export function matchAgents(values: readonly AgentValue[], credits: readonly AgentCredits[], studioCost: number | undefined): AgentMatch {
    const byName = new Map(values.map((agent) => [agentKey(agent.name), agent]));
    const totalCredits = credits.reduce((total, agent) => total + agent.credits, 0);
    const lines: AgentLine[] = [];
    const unmatched: string[] = [];
    for (const agent of credits) {
        const match = byName.get(agentKey(agent.name));
        if (!match) {
            unmatched.push(agent.name);
            continue;
        }
        const share = totalCredits > 0 ? agent.credits / totalCredits : 0;
        const cost = studioCost === undefined ? undefined : studioCost * share;
        lines.push({ name: match.name, share, cost, sessions: match.sessions, value: match.value, ratio: returnOn(match.value, cost) });
    }
    lines.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.name.localeCompare(b.name));
    return { lines, unmatched, total: credits.length };
}

export const AGENT_TABLE_COLUMNS = ["Pair", "Share", "Cost", "Sessions", "Value", "Return", "Sort"] as const;

/** The matched agents as one table, for the grid and the cost-and-value chart alike. */
export function agentTable(lines: readonly AgentLine[]): DataTable {
    return {
        columns: [
            { name: "Pair", displayName: "Agent" },
            { name: "Share", displayName: "Share of credits", format: FORMAT_PERCENT },
            { name: "Cost", displayName: "Allocated cost", format: FORMAT_MONEY },
            { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
            { name: "Value", displayName: "Estimated value", format: FORMAT_WHOLE },
            { name: "Return", displayName: "Return", format: "0.0" },
            { name: "Sort", displayName: "Order", format: FORMAT_WHOLE },
        ],
        rows: lines.map((line, index) => [
            line.name,
            line.share,
            line.cost ?? null,
            line.sessions ?? null,
            line.value ?? null,
            line.ratio ?? null,
            index,
        ]),
    };
}

/**
 * Cost and value as two dots joined by a line, one row per pair, labelled in
 * the value's currency. Reads the `Pair`, `Cost`, `Value` and `Sort` columns.
 */
export function costValueSpec(currencySymbol: string): VisualizationSpec {
    // The symbol lands inside a single-quoted Vega expression string.
    const symbol = currencySymbol.replace(/['"\\]/g, "");
    return JSON.parse(JSON.stringify(costValueSpecTemplate).replaceAll("__CURRENCY__", symbol)) as VisualizationSpec;
}
