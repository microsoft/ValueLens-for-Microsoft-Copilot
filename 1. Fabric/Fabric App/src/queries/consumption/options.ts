//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { dateBetween, treatAs } from "@/lib/dax-filters";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection as connection, FORMAT_WHOLE } from "../shared";
import query from "./consumption-options.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Kind]": { name: "Kind", displayName: "Kind" },
    "[Value]": { name: "Value", displayName: "Value" },
    "[Sort]": { name: "Sort", displayName: "Sort", format: FORMAT_WHOLE },
};

/** Every slicer choice the report offers, read from the model so renamed periods stay in step. */
export function consumptionOptions() {
    return { connection, query, columnMetadata };
}

export interface ConsumptionOptions {
    coworkPeriods: string[];
    studioPeriods: string[];
    groupBy: string[];
    services: string[];
    costBases: string[];
}

const KINDS: Record<string, keyof ConsumptionOptions> = {
    "Cowork period": "coworkPeriods",
    "Studio period": "studioPeriods",
    "Group by": "groupBy",
    Service: "services",
    "Cost basis": "costBases",
};

/** Sorts the options query into one list per slicer, keeping the model's order. */
export function readConsumptionOptions(table: DataTable): ConsumptionOptions {
    const options: ConsumptionOptions = { coworkPeriods: [], studioPeriods: [], groupBy: [], services: [], costBases: [] };
    const kind = table.columns.findIndex((column) => column.name === "Kind");
    const value = table.columns.findIndex((column) => column.name === "Value");
    for (const row of table.rows) {
        const list = KINDS[String(row[kind])];
        const text = row[value];
        if (list && typeof text === "string" && text.trim() !== "") options[list].push(text);
    }
    return options;
}

/** The Group By choice that puts everyone in one group, and the model's default. */
export const ALL_USERS = "All users";

/**
 * Group By attributes worth offering. Identifier columns and single-person
 * groupings repeat the people table, and each product only offers its own
 * usage intensity.
 */
const HIDDEN_ATTRIBUTES = new Set(["id", "user id", "manager_user id", "user"]);

const ATTRIBUTE_LABELS: Record<string, string> = {
    "Job Family": "Job family",
    "Usage Intensity (Cowork)": "Usage intensity",
    "Usage Intensity (Studio)": "Usage intensity",
};

export interface GroupByChoice {
    value: string;
    label: string;
}

export function groupByChoices(attributes: readonly string[], product: "Cowork" | "Studio"): GroupByChoice[] {
    return attributes
        .filter((attribute) => attribute !== ALL_USERS && !HIDDEN_ATTRIBUTES.has(attribute.toLowerCase()))
        .filter((attribute) => {
            const intensity = /^Usage Intensity \((.+)\)$/i.exec(attribute);
            return !intensity || intensity[1].toLowerCase() === product.toLowerCase();
        })
        .map((attribute) => ({ value: attribute, label: ATTRIBUTE_LABELS[attribute] ?? attribute }));
}

/** Always applied: without it every attribute's groups would be listed together. */
export function groupByFilter(attribute: string | undefined): string {
    return treatAs("'Group By'[Attribute]", [attribute ?? ALL_USERS]);
}

export function coworkPeriodFilter(period: string): string {
    return treatAs("'Cowork Period'[Period]", [period]);
}

export function studioPeriodFilter(period: string): string {
    return treatAs("'Studio Period'[Period]", [period]);
}

/** The report's service slicer: Cowork, Work IQ, or both when unset. */
export function serviceFilter(service: string): string {
    return treatAs("CreditsWeekly[ServiceName]", [service]);
}

/** The model spells it as one word; people read it as two. */
export function serviceLabel(service: string): string {
    return service === "WorkIQ" ? "Work IQ" : service;
}

export function reportingDateFilter(from: string, to: string): string {
    return dateBetween("'Reporting Date'[Date]", from, to);
}

export function costBasisFilter(basis: string): string {
    return treatAs("'Azure Cost Basis'[Cost Basis]", [basis]);
}

export function azureCurrencyFilter(currency: string): string {
    return treatAs("AzureSolutionSpend[Currency]", [currency]);
}

/** The model returns dates as ISO date-times; the filter helpers take the date part. */
export function isoDate(value: unknown): string | undefined {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}
