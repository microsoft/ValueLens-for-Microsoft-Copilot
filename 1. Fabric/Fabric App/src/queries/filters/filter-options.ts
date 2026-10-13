//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { QueryTable } from "@microsoft/fabric-app-data";
import { pickOrgAttributes, withOrgAttribute, type OrgAttribute, type OrgColumnStatistic } from "@/lib/org-attribute";
import { connection } from "../shared";
import query from "./filter-options.dax?raw";
import orgAttributesQuery from "./org-attributes.dax?raw";
import orgValuesQuery from "./org-values.dax?raw";

/** The values the filter bar offers, read once from the model. */
export interface FilterOptions {
    agentTypes: string[];
    agentNames: string[];
    /** Values of the Activity column present in the data: Copilot, Agents, Cowork. */
    activities: string[];
    /** First date with activity, ISO `yyyy-mm-dd`. */
    firstDate: string | undefined;
    /** Last date with activity, ISO `yyyy-mm-dd`. */
    lastDate: string | undefined;
}

/**
 * Everything the filter bar needs that does not depend on the org attribute,
 * in one round trip. It runs unfiltered, so the choices never narrow as
 * filters are applied.
 */
export function filterOptions() {
    return { connection, query };
}

function columnIndex(table: QueryTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

/** Splits the `Kind` / `Value` rows of {@link filterOptions} into lists. */
export function toFilterOptions(table: QueryTable): FilterOptions {
    const kindIndex = columnIndex(table, "[Kind]");
    const valueIndex = columnIndex(table, "[Value]");
    const options: FilterOptions = {
        agentTypes: [],
        agentNames: [],
        activities: [],
        firstDate: undefined,
        lastDate: undefined,
    };

    for (const row of table.rows) {
        const kind = row[kindIndex];
        const value = row[valueIndex];
        if (typeof value !== "string" || value.trim() === "") continue;
        if (kind === "agentType") options.agentTypes.push(value);
        else if (kind === "agentName") options.agentNames.push(value);
        else if (kind === "activity") options.activities.push(value);
        else if (kind === "firstDate") options.firstDate = value;
        else if (kind === "lastDate") options.lastDate = value;
    }

    return options;
}

/**
 * The columns of the org mapping table, with the statistics needed to tell a
 * grouping (department, location) from an identifier (email, id).
 * `COLUMNSTATISTICS` needs only read access, so it works for every viewer.
 */
export function orgAttributeOptions() {
    return { connection, query: orgAttributesQuery };
}

/** The org columns worth grouping by, `Organization` first. */
export function toOrgAttributes(table: QueryTable): string[] {
    const column = columnIndex(table, "[Column]");
    const cardinality = columnIndex(table, "[Cardinality]");
    const maxLength = columnIndex(table, "[Max Length]");
    const people = columnIndex(table, "[People]");

    const stats: OrgColumnStatistic[] = table.rows
        .filter((row) => typeof row[column] === "string")
        .map((row) => ({
            column: row[column] as string,
            cardinality: Number(row[cardinality] ?? 0),
            maxLength: typeof row[maxLength] === "number" ? row[maxLength] : undefined,
        }));
    const headcount = Number(table.rows[0]?.[people] ?? 0);

    return pickOrgAttributes(stats, headcount);
}

/** The distinct, non-blank values of one org attribute. */
export function orgValueOptions(attribute: OrgAttribute) {
    return withOrgAttribute({ connection, query: orgValuesQuery }, attribute);
}

export function toOrgValues(table: QueryTable): string[] {
    const value = columnIndex(table, "[Value]");
    return table.rows
        .map((row) => row[value])
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}
