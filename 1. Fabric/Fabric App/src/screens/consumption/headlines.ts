//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { leaderHeadline, peakHeadline, splitHeadline, type Headline } from "@/lib/headline";

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * "Cowork / Work IQ has the highest cost of the 3 products." Each product's
 * cost keeps its own basis, so the costs are compared, never added up into
 * shares. When Azure bills in another currency than the credits, only the
 * products priced in credits (those with a credit count) are compared.
 */
export function productCostHeadline(sameCurrency: boolean): Headline {
    return (table: DataTable) => {
        const at = (name: string) => table.columns.findIndex((column) => column.name === name);
        const [product, cost, credits] = ["Product", "Cost", "Credits"].map(at);
        if (product < 0 || cost < 0) return undefined;
        const costs: [string, number][] = [];
        for (const row of table.rows) {
            const name = row[product];
            const amount = finite(row[cost]);
            if (typeof name !== "string" || name.trim() === "" || amount === undefined) continue;
            const priced = credits >= 0 && finite(row[credits]) !== undefined;
            if (!sameCurrency && !priced) continue;
            costs.push([name, amount]);
        }
        if (costs.length < 2 || costs.some(([, amount]) => amount < 0)) return undefined;
        costs.sort((a, b) => b[1] - a[1]);
        const [name, amount] = costs[0];
        if (amount <= 0 || costs[1][1] === amount) return undefined;
        const among = sameCurrency ? "products" : "products billed in credits";
        return `${name} has the highest cost of the ${costs.length} ${among}.`;
    };
}

export const PRODUCT_COST_SAME_CURRENCY = productCostHeadline(true);
export const PRODUCT_COST_CREDITS_ONLY = productCostHeadline(false);

const PREPAID_PAYG_COST = [
    { column: "Prepaid Cost", label: "prepaid" },
    { column: "PAYG Cost", label: "pay-as-you-go" },
] as const;

/** Cowork's weekly credits: the busiest week the export holds. */
export const COWORK_CREDITS_HEADLINE = peakHeadline({ date: "Week Start", value: "Credits", of: "credits", period: "week" });

/** Cowork's weekly cost: how much of it prepaid capacity covers. */
export const COWORK_COST_HEADLINE = splitHeadline({ parts: PREPAID_PAYG_COST, of: "the cost" });

/** Copilot Studio's daily credits, prepaid against pay-as-you-go. */
export const STUDIO_CREDITS_HEADLINE = splitHeadline({
    parts: [
        { column: "Prepaid Credits", label: "prepaid" },
        { column: "PAYG Credits", label: "pay-as-you-go" },
    ],
    of: "credits",
});

/** Copilot Studio's daily cost, prepaid against pay-as-you-go. */
export const STUDIO_COST_HEADLINE = splitHeadline({ parts: PREPAID_PAYG_COST, of: "the cost" });

/** The largest model or feature behind Copilot Studio's credits. */
export const BREAKDOWN_CREDITS_HEADLINE = leaderHeadline({ label: "Item", value: "Credits", of: "credits" });

/** The largest model or feature behind Copilot Studio's estimated cost. */
export const BREAKDOWN_COST_HEADLINE = leaderHeadline({ label: "Item", value: "Cost", of: "the estimated cost" });

/** The product with the most pay-as-you-go credits Azure billed. */
export const AZURE_BILLED_CREDITS_HEADLINE = leaderHeadline({
    label: "Product",
    value: "Credits",
    of: "the pay-as-you-go credits billed in Azure",
});

/** The product with the most pay-as-you-go cost Azure billed; only read when Azure billed in one currency. */
export const AZURE_BILLED_COST_HEADLINE = leaderHeadline({
    label: "Product",
    value: "Cost",
    of: "the pay-as-you-go cost billed in Azure",
});
