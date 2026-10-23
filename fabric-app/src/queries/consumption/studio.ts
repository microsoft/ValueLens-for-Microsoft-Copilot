//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CONSUMPTION_AZURE, CONSUMPTION_STUDIO_AGENT, CONSUMPTION_STUDIO_PEOPLE, CONSUMPTION_STUDIO_TENANT } from "@/lib/filter-profiles";
import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import {
    CONCENTRATION_COLUMNS,
    consumptionConnection as connection,
    FORMAT_CREDITS,
    FORMAT_MONEY,
    FORMAT_PERCENT,
    FORMAT_RATE,
    FORMAT_WHOLE,
    TOTAL_COLUMN,
} from "../shared";
import type { ConsumptionLens } from "./cowork";
import agentsQuery from "./studio-agents.dax?raw";
import azureBillingQuery from "./studio-azure-billing.dax?raw";
import azureDailyQuery from "./studio-azure-daily.dax?raw";
import azureDailyCostSpec from "./studio-azure-daily-cost.json";
import azureDailyCreditsSpec from "./studio-azure-daily-credits.json";
import breakdownQuery from "./studio-breakdown.dax?raw";
import breakdownCostSpec from "./studio-breakdown-cost.json";
import breakdownCreditsSpec from "./studio-breakdown-credits.json";
import concentrationQuery from "./studio-concentration.dax?raw";
import summaryQuery from "./studio-credits-summary.dax?raw";
import dailyQuery from "./studio-daily.dax?raw";
import dailyCostSpec from "./studio-daily-cost.json";
import dailyCreditsSpec from "./studio-daily-credits.json";
import usersQuery from "./studio-users.dax?raw";

const summaryColumns: ColumnMetadataMap = {
    "[Credits Consumed]": { name: "Credits Consumed", displayName: "Credits consumed", format: FORMAT_CREDITS },
    "[Active Users]": { name: "Active Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Agents With Credits]": { name: "Agents With Credits", displayName: "Agents with credits", format: FORMAT_WHOLE },
    "[Avg Credits Per User]": { name: "Avg Credits Per User", displayName: "Credits per user", format: FORMAT_CREDITS },
    "[Avg Agents Per User]": { name: "Avg Agents Per User", displayName: "Agents per user", format: FORMAT_RATE },
    "[Total Cost]": { name: "Total Cost", displayName: "Total cost", format: FORMAT_MONEY },
    "[Prepaid Cost]": { name: "Prepaid Cost", displayName: "Prepaid", format: FORMAT_MONEY },
    "[PAYG Cost]": { name: "PAYG Cost", displayName: "Pay-as-you-go", format: FORMAT_MONEY },
    "[PAYG Share]": { name: "PAYG Share", displayName: "Pay-as-you-go share", format: FORMAT_PERCENT },
    "[Effective Rate]": { name: "Effective Rate", displayName: "Effective rate", format: "0.0000" },
    "[Avg Cost Per User]": { name: "Avg Cost Per User", displayName: "Cost per user", format: FORMAT_MONEY },
    "[Billing Period]": { name: "Billing Period", displayName: "Billing period" },
    "[Period Label]": { name: "Period Label", displayName: "Period" },
    "[Concentration]": { name: "Concentration", displayName: "Concentration" },
    "[Snapshot Note]": { name: "Snapshot Note", displayName: "Snapshot note" },
    "[Org Match Rate]": { name: "Org Match Rate", displayName: "Org match rate", format: FORMAT_PERCENT },
    "[Org Filter Status]": { name: "Org Filter Status", displayName: "Group By status" },
};

/**
 * The headline cards of the report's Studio Consumption and Cost pages. The
 * period only moves the tenant totals; per-user figures are a month-to-date
 * snapshot, which the snapshot note says in the model's own words.
 */
export function studioCreditsSummary() {
    return { connection, filters: CONSUMPTION_STUDIO_TENANT, query: summaryQuery, columnMetadata: summaryColumns };
}

const dailyColumns: ColumnMetadataMap = {
    "[Usage Date]": { name: "Usage Date", displayName: "Day" },
    "[Prepaid Credits]": { name: "Prepaid Credits", displayName: "Prepaid credits", format: FORMAT_CREDITS },
    "[PAYG Credits]": { name: "PAYG Credits", displayName: "Pay-as-you-go credits", format: FORMAT_CREDITS },
    "[Credits]": { name: "Credits", displayName: "Credits", format: FORMAT_CREDITS },
    "[Prepaid Cost]": { name: "Prepaid Cost", displayName: "Prepaid cost", format: FORMAT_MONEY },
    "[PAYG Cost]": { name: "PAYG Cost", displayName: "Pay-as-you-go cost", format: FORMAT_MONEY },
};

/** Tenant credits and cost for each day with usage, split into prepaid and pay-as-you-go. */
export function studioDaily(lens: ConsumptionLens = "consumption") {
    const spec = lens === "cost" ? dailyCostSpec : dailyCreditsSpec;
    return { connection, filters: CONSUMPTION_STUDIO_TENANT, query: dailyQuery, columnMetadata: dailyColumns, vegaLiteSpec: spec as VisualizationSpec };
}

/**
 * Draws the daily chart's 7-day average line in the given colour, so it reads
 * against the bars in both light and dark themes. Other layers are untouched.
 */
export function withTrendLineColor(spec: VisualizationSpec, color: string): VisualizationSpec {
    const layers = (spec as { layer?: Array<{ mark?: unknown }> }).layer;
    if (!layers) return spec;
    return {
        ...spec,
        layer: layers.map((layer) => {
            const mark = layer.mark as { type?: string } | undefined;
            return mark?.type === "line" ? { ...layer, mark: { ...mark, color } } : layer;
        }),
    } as VisualizationSpec;
}

const azureBillingColumns: ColumnMetadataMap = {
    "[Studio Cost]": { name: "Studio Cost", displayName: "Copilot Studio", format: FORMAT_MONEY },
    "[Studio Credits]": { name: "Studio Credits", displayName: "Copilot Studio credits", format: FORMAT_CREDITS },
    "[Cowork Cost]": { name: "Cowork Cost", displayName: "Cowork", format: FORMAT_MONEY },
    "[Cowork Credits]": { name: "Cowork Credits", displayName: "Cowork credits", format: FORMAT_CREDITS },
    "[Other Cost]": { name: "Other Cost", displayName: "Other", format: FORMAT_MONEY },
    "[Total Cost]": { name: "Total Cost", displayName: "Billed in Azure", format: FORMAT_MONEY },
    "[Currency]": { name: "Currency", displayName: "Currency" },
    "[Currencies]": { name: "Currencies", displayName: "Currencies" },
    "[Subscriptions]": { name: "Subscriptions", displayName: "Subscriptions", format: FORMAT_WHOLE },
    "[First Date]": { name: "First Date", displayName: "First day" },
    "[Last Date]": { name: "Last Date", displayName: "Last day" },
    "[Rows]": { name: "Rows", displayName: "Rows", format: FORMAT_WHOLE },
};

/**
 * Copilot pay-as-you-go as Azure billed it, over the Studio period. Older
 * models have no CopilotPaygSpend table, so the query errors there and the
 * screen leaves the panel out.
 */
export function studioAzureBilling() {
    return { connection, filters: CONSUMPTION_AZURE, query: azureBillingQuery, columnMetadata: azureBillingColumns };
}

const azureDailyColumns: ColumnMetadataMap = {
    "[Usage Date]": { name: "Usage Date", displayName: "Day" },
    "[Product]": { name: "Product", displayName: "Product" },
    "[Product Sort]": { name: "Product Sort" },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
    "[Credits]": { name: "Credits", displayName: "Credits", format: FORMAT_CREDITS },
};

/** Each day's pay-as-you-go billed in Azure, by product. */
export function studioAzureDaily(lens: ConsumptionLens = "consumption") {
    const spec = lens === "cost" ? azureDailyCostSpec : azureDailyCreditsSpec;
    return { connection, filters: CONSUMPTION_AZURE, query: azureDailyQuery, columnMetadata: azureDailyColumns, vegaLiteSpec: spec as VisualizationSpec };
}

export type StudioBreakdown = "Model" | "Feature";

const breakdownColumns: ColumnMetadataMap = {
    "[Breakdown]": { name: "Breakdown", displayName: "Breakdown" },
    "[Item]": { name: "Item", displayName: "Item" },
    "[Credits]": { name: "Credits", displayName: "Credits", format: FORMAT_CREDITS },
    "[Cost]": { name: "Cost", displayName: "Estimated cost", format: FORMAT_MONEY },
};

/**
 * Agent credits by the model behind them and by the billable feature, in
 * one round trip; the screen splits the rows between the two charts.
 */
export function studioBreakdown(lens: ConsumptionLens = "consumption") {
    const spec = lens === "cost" ? breakdownCostSpec : breakdownCreditsSpec;
    return {
        connection,
        filters: CONSUMPTION_STUDIO_AGENT,
        query: breakdownQuery,
        columnMetadata: breakdownColumns,
        vegaLiteSpec: spec as VisualizationSpec,
    };
}

/** The rows of one breakdown, for one chart. */
export function breakdownRows(table: DataTable, breakdown: StudioBreakdown): DataTable {
    const index = table.columns.findIndex((column) => column.name === "Breakdown");
    return { ...table, rows: table.rows.filter((row) => row[index] === breakdown) };
}

const agentsColumns: ColumnMetadataMap = {
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Credits Used]": { name: "Credits Used", displayName: "Credits used", format: FORMAT_CREDITS },
    "[Credit Share]": { name: "Credit Share", displayName: "Share", format: FORMAT_PERCENT },
    "[Billable Credits]": { name: "Billable Credits", displayName: "Billable credits", format: FORMAT_CREDITS },
    "[Estimated Cost]": { name: "Estimated Cost", displayName: "Estimated cost", format: FORMAT_MONEY },
    ...TOTAL_COLUMN,
};

/** Top 1,000 agents in the user snapshot; shares and Total still cover the full snapshot. */
export function studioAgents() {
    return { connection, filters: CONSUMPTION_STUDIO_PEOPLE, query: agentsQuery, columnMetadata: agentsColumns };
}

const GROUP_COLUMN = "Group ByGroup";
const USER_COLUMN = "Credit Consumption (User)User Name";

/** The user on the users table's person rows. */
export const STUDIO_USER_COLUMN = USER_COLUMN;

/** The grid's first column: the group on group rows, the user on leaf rows. */
export const STUDIO_LABEL_COLUMN = "Who";
export const STUDIO_USER_FIELDS = ["Credits Used", "Credit Share", "Billable Credits", "Estimated Cost", "Policy"] as const;

const usersColumns: ColumnMetadataMap = {
    "Group By[Group]": { name: GROUP_COLUMN, displayName: "Group" },
    "Credit Consumption (User)[User Name]": { name: USER_COLUMN, displayName: "User" },
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[Credits Used]": { name: "Credits Used", displayName: "Credits used", format: FORMAT_CREDITS },
    "[Credit Share]": { name: "Credit Share", displayName: "Share", format: FORMAT_PERCENT },
    "[Billable Credits]": { name: "Billable Credits", displayName: "Billable credits", format: FORMAT_CREDITS },
    "[Estimated Cost]": { name: "Estimated Cost", displayName: "Estimated cost", format: FORMAT_MONEY },
    "[Policy]": { name: "Policy", displayName: "Billing policy" },
    ...TOTAL_COLUMN,
};

/** The report's top-users table: each group, then its users, from the user snapshot. */
export function studioUsers() {
    return { connection, filters: CONSUMPTION_STUDIO_PEOPLE, query: usersQuery, columnMetadata: usersColumns };
}

/**
 * How much of the user snapshot's credits the busiest users account for,
 * worked out over every user in the top-users table rather than the top of
 * it. Read the rows with `readConcentration`.
 */
export function studioConcentration() {
    return { connection, filters: CONSUMPTION_STUDIO_PEOPLE, query: concentrationQuery, columnMetadata: CONCENTRATION_COLUMNS };
}

export function toStudioUserTree(table: DataTable): RollupTree {
    return toRollupTree(table, {
        group: GROUP_COLUMN,
        leaf: USER_COLUMN,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: STUDIO_LABEL_COLUMN,
        fields: STUDIO_USER_FIELDS,
        blankLabel: "(No value)",
    });
}
