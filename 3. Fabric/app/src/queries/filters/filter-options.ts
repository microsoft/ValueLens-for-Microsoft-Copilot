//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { QueryTable } from "@microsoft/fabric-app-data";
import { connection } from "../shared";
import query from "./filter-options.dax?raw";

/** The values the filter bar offers, read once from the model. */
export interface FilterOptions {
    organizations: string[];
    agentTypes: string[];
    /** First date with activity, ISO `yyyy-mm-dd`. */
    firstDate: string | undefined;
    /** Last date with activity, ISO `yyyy-mm-dd`. */
    lastDate: string | undefined;
}

/**
 * Everything the filter bar needs in one round trip: the organizations and
 * agent types to choose from, and the window the audit data covers. It runs
 * unfiltered, so the choices never narrow as filters are applied.
 */
export function filterOptions() {
    return { connection, query };
}

/** Splits the `Kind` / `Value` rows of {@link filterOptions} into lists. */
export function toFilterOptions(table: QueryTable): FilterOptions {
    const kindIndex = table.columns.findIndex((column) => column.name === "[Kind]");
    const valueIndex = table.columns.findIndex((column) => column.name === "[Value]");
    const options: FilterOptions = { organizations: [], agentTypes: [], firstDate: undefined, lastDate: undefined };

    for (const row of table.rows) {
        const kind = row[kindIndex];
        const value = row[valueIndex];
        if (typeof value !== "string" || value.trim() === "") continue;
        if (kind === "organization") options.organizations.push(value);
        else if (kind === "agentType") options.agentTypes.push(value);
        else if (kind === "firstDate") options.firstDate = value;
        else if (kind === "lastDate") options.lastDate = value;
    }

    return options;
}