//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./cowork-candidates.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Rank]": { name: "Rank", displayName: "Rank", format: FORMAT_WHOLE },
    "[User]": { name: "User", displayName: "User" },
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[Surfaces Per Day]": { name: "Surfaces Per Day", displayName: "Apps per active day", format: FORMAT_RATE },
    "[Prompts Per Session]": {
        name: "Prompts Per Session",
        displayName: "Prompts per session",
        format: FORMAT_RATE,
    },
    "[Uses Agents]": { name: "Uses Agents", displayName: "Uses agents" },
};

/**
 * Everyone who could be offered Cowork next, best candidates first.
 *
 * `Cowork Readiness Rank (Dynamic)` is context-bound: it ranks against
 * whoever else is in scope, and switches to a per-organization rank when
 * `Organization` is a grouping column. Grouping by user alone keeps the rank
 * organization-wide; the organization is looked up per person instead, over
 * the one-directional `Audit_UserId` → `PersonId` relationship, so it labels
 * each row without narrowing the ranking.
 */
export function coworkCandidates() {
    return { connection, query, columnMetadata };
}

/**
 * True when every candidate has the same prompts-per-session figure, so depth
 * cannot separate anyone and breadth and agent use decide the ranking alone.
 * Tenants whose audit log records one prompt per session always land here.
 */
export function isDepthUniform(table: DataTable): boolean {
    const index = table.columns.findIndex((column) => column.name === "Prompts Per Session");
    if (index < 0) return false;
    const depths = new Set(table.rows.map((row) => row[index]).filter((value) => typeof value === "number"));
    return depths.size === 1;
}
