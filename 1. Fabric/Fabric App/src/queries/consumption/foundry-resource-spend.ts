//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection as connection, FORMAT_MONEY, FORMAT_WHOLE } from "../shared";
import query from "./foundry-resource-spend.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Resource]": { name: "Resource", displayName: "Foundry resource" },
    "[Kind]": { name: "Kind", displayName: "Kind" },
    "[Resource Group]": { name: "Resource Group", displayName: "Resource group" },
    "[Subscription]": { name: "Subscription", displayName: "Subscription" },
    "[Projects]": { name: "Projects", displayName: "Projects", format: FORMAT_WHOLE },
    "[Network]": { name: "Network", displayName: "Network" },
    "[Cost Export]": { name: "Cost Export", displayName: "Cost export" },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
};

/**
 * Each Foundry account (or hub or workspace) Azure Resource Graph lists, at
 * its latest snapshot, with its project count and the whole-solution cost of
 * the account and anything under it. The model has no relationship between
 * the two tables, so the query matches resource ids itself, ignoring case.
 * `Cost Export` says whether the account's subscription appears in the cost
 * export at all, so a missing cost reads as a gap rather than as free.
 */
export function foundryResourceSpend() {
    return { connection, query, columnMetadata };
}

export interface FoundryInventory {
    accounts: number;
    projects: number;
    publicNetwork: number;
    cost: number;
    /** Subscriptions with Foundry resources that the cost export doesn't cover. */
    uncoveredSubscriptions: string[];
    uncoveredAccounts: number;
}

/** The headline figures for the Foundry inventory, read from its table. */
export function summariseFoundryInventory(table: DataTable | undefined): FoundryInventory | undefined {
    if (!table || table.rows.length === 0) return undefined;
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [projects, network, coverage, cost, subscription] = [
        at("Projects"),
        at("Network"),
        at("Cost Export"),
        at("Cost"),
        at("Subscription"),
    ];
    const uncovered = table.rows.filter((row) => row[coverage] === "Not covered");
    return {
        accounts: table.rows.length,
        projects: table.rows.reduce((sum, row) => sum + (Number(row[projects]) || 0), 0),
        publicNetwork: table.rows.filter((row) => row[network] === "Public").length,
        cost: table.rows.reduce((sum, row) => sum + (Number(row[cost]) || 0), 0),
        uncoveredSubscriptions: [...new Set(uncovered.map((row) => String(row[subscription] ?? "")).filter(Boolean))].sort(),
        uncoveredAccounts: uncovered.length,
    };
}

export const FOUNDRY_INVENTORY_NOT_SET_UP = {
    title: "Foundry inventory isn't loaded",
    description:
        "Turn on Azure Resource Graph in the installer to see the cost of each Foundry account and project, and the subscriptions the cost export misses. It fills in after the next load and model refresh.",
};

/** Says which subscriptions hold Foundry resources the cost export can't price. */
export function uncoveredNote(subscriptions: readonly string[], accounts: number): string | undefined {
    if (subscriptions.length === 0) return undefined;
    const list = subscriptions.length <= 3 ? `: ${subscriptions.join(", ")}` : "";
    return (
        `${accounts} Foundry ${accounts === 1 ? "resource sits" : "resources sit"} in ` +
        `${subscriptions.length} ${subscriptions.length === 1 ? "subscription" : "subscriptions"} the Azure cost export doesn't cover${list}. ` +
        `Add ${subscriptions.length === 1 ? "it" : "them"} to the export's scope to see what ${accounts === 1 ? "it costs" : "they cost"}.`
    );
}
