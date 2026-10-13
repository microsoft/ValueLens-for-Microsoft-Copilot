//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import {
    consumptionConnection as connection,
    FORMAT_CREDITS,
    FORMAT_MONEY,
    FORMAT_PERCENT,
    FORMAT_WHOLE,
} from "../shared";
import byGroupQuery from "./cowork-by-group.dax?raw";
import summaryQuery from "./cowork-credits-summary.dax?raw";
import weeklyQuery from "./cowork-weekly.dax?raw";
import weeklyCostSpec from "./cowork-weekly-cost.json";
import weeklyCreditsSpec from "./cowork-weekly-credits.json";
import windowCostQuery from "./cowork-window-cost.dax?raw";

/** The report's two Cowork pages: what was consumed, and what it cost. */
export type ConsumptionLens = "consumption" | "cost";

const summaryColumns: ColumnMetadataMap = {
    "[Credits Used]": { name: "Credits Used", displayName: "Credits used", format: FORMAT_CREDITS },
    "[Consuming Users]": { name: "Consuming Users", displayName: "Consuming users", format: FORMAT_WHOLE },
    "[Weekly Active Users]": { name: "Weekly Active Users", displayName: "Weekly active users", format: FORMAT_WHOLE },
    "[Avg Credits Per User]": { name: "Avg Credits Per User", displayName: "Credits per user", format: FORMAT_CREDITS },
    "[Allowance Used]": { name: "Allowance Used", displayName: "Allowance used", format: FORMAT_PERCENT },
    "[Users Over Limit]": { name: "Users Over Limit", displayName: "Users over limit", format: FORMAT_PERCENT },
    "[Policies]": { name: "Policies", displayName: "Policies", format: FORMAT_WHOLE },
    "[Total Cost]": { name: "Total Cost", displayName: "Total cost", format: FORMAT_MONEY },
    "[Prepaid Cost]": { name: "Prepaid Cost", displayName: "Prepaid", format: FORMAT_MONEY },
    "[PAYG Cost]": { name: "PAYG Cost", displayName: "Pay-as-you-go", format: FORMAT_MONEY },
    "[Blended Rate]": { name: "Blended Rate", displayName: "Blended rate", format: "0.0000" },
    "[Avg Cost Per User]": { name: "Avg Cost Per User", displayName: "Cost per user", format: FORMAT_MONEY },
    "[Policy Headroom]": { name: "Policy Headroom", displayName: "Policy headroom", format: FORMAT_CREDITS },
    "[Billing Basis]": { name: "Billing Basis", displayName: "Billing basis" },
    "[Period Label]": { name: "Period Label", displayName: "Period" },
};

/**
 * The headline cards of the report's Cowork Consumption and Cost pages, for
 * the chosen period and service. Cost is prepaid capacity first, then
 * pay-as-you-go once the packs run out.
 */
export function coworkCreditsSummary() {
    return { connection, query: summaryQuery, columnMetadata: summaryColumns };
}

const weeklyColumns: ColumnMetadataMap = {
    "[Week Index]": { name: "Week Index", displayName: "Week", format: FORMAT_WHOLE },
    "[Week Start]": { name: "Week Start", displayName: "Week starting" },
    "[Credits]": { name: "Credits", displayName: "Credits", format: FORMAT_CREDITS },
    "[Active Users]": { name: "Active Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Prepaid Cost]": { name: "Prepaid Cost", displayName: "Prepaid", format: FORMAT_MONEY },
    "[PAYG Cost]": { name: "PAYG Cost", displayName: "Pay-as-you-go", format: FORMAT_MONEY },
    "[Credits WoW]": { name: "Credits WoW", displayName: "Week on week", format: FORMAT_PERCENT },
};

/**
 * Credits for every week the export holds, whatever the period, and the
 * prepaid and pay-as-you-go cost of the weeks inside the period. One query
 * feeds both lenses; the lens only picks the chart.
 */
export function coworkWeekly(lens: ConsumptionLens = "consumption") {
    const spec = lens === "cost" ? weeklyCostSpec : weeklyCreditsSpec;
    return { connection, query: weeklyQuery, columnMetadata: weeklyColumns, vegaLiteSpec: spec as VisualizationSpec };
}

const windowCostColumns: ColumnMetadataMap = {
    "[Credits]": { name: "Credits", displayName: "Credits used", format: FORMAT_CREDITS },
    "[Prepaid Credits]": { name: "Prepaid Credits", displayName: "Prepaid credits", format: FORMAT_CREDITS },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
};

/**
 * Cowork's credits and cost over the dates the report's date filter sets,
 * priced with the Capacity Pack: up to the balance at the prepaid rate, the
 * rest at pay-as-you-go. The Combined page prices them all at pay-as-you-go.
 */
export function coworkWindowCost() {
    return { connection, query: windowCostQuery, columnMetadata: windowCostColumns };
}

const GROUP_COLUMN = "Group ByGroup";
const PERSON_COLUMN = "OrgDisplayName";
const SIGN_IN_COLUMN = "OrgUserPrincipalName";
const BILLING_NAME_COLUMN = "Billing Name";

/** The grid's first column: the group on group rows, the person on leaf rows. */
export const COWORK_LABEL_COLUMN = "Who";
export const COWORK_GROUP_FIELDS = [
    "Users",
    "Credits Used",
    "Allowance Used",
    "Prepaid Cost",
    "PAYG Cost",
    "Total Cost",
    "Policy",
] as const;

const byGroupColumns: ColumnMetadataMap = {
    "Group By[Group]": { name: GROUP_COLUMN, displayName: "Group" },
    "Org[DisplayName]": { name: PERSON_COLUMN, displayName: "Person" },
    "Org[UserPrincipalName]": { name: SIGN_IN_COLUMN, displayName: "Sign-in name" },
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[Users]": { name: "Users", displayName: "Users", format: FORMAT_WHOLE },
    "[Credits Used]": { name: "Credits Used", displayName: "Credits used", format: FORMAT_CREDITS },
    "[Allowance Used]": { name: "Allowance Used", displayName: "Allowance used", format: FORMAT_PERCENT },
    "[Prepaid Cost]": { name: "Prepaid Cost", displayName: "Prepaid", format: FORMAT_MONEY },
    "[PAYG Cost]": { name: "PAYG Cost", displayName: "Pay-as-you-go", format: FORMAT_MONEY },
    "[Total Cost]": { name: "Total Cost", displayName: "Total cost", format: FORMAT_MONEY },
    "[Policy]": { name: "Policy", displayName: "Policy" },
    "[Billing Name]": { name: BILLING_NAME_COLUMN },
};

/**
 * The report's Cowork group table: each group of the chosen Group By
 * attribute, largest first, then the people in it, with their credits,
 * allowance and cost.
 */
export function coworkByGroup() {
    return { connection, query: byGroupQuery, columnMetadata: byGroupColumns };
}

function named(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function toCoworkGroupTree(table: DataTable): RollupTree {
    return toRollupTree(table, {
        group: GROUP_COLUMN,
        leaf: SIGN_IN_COLUMN,
        // The org data's name first, then the billing export's, then the
        // sign-in name itself. A row with no sign-in name is everyone the org
        // data does not list, so one billing name would mislabel it.
        leafLabel: (signIn, cell) =>
            named(signIn) ? (named(cell(PERSON_COLUMN)) ?? named(cell(BILLING_NAME_COLUMN))) : undefined,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: COWORK_LABEL_COLUMN,
        fields: COWORK_GROUP_FIELDS,
        blankLabel: "(No value)",
    });
}
