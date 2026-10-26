//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE, TOTAL_COLUMN } from "../shared";
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
    "[Depths]": { name: "Depths", displayName: "Distinct prompts per session", format: FORMAT_WHOLE },
    ...TOTAL_COLUMN,
};

/**
 * Everyone who could be offered Cowork next, best candidates first: the
 * first `LIST_LIMIT` of them, with `[Total]` counting them all.
 *
 * The rank is the model's `Cowork Readiness Rank (Dynamic)` for a person with
 * no organization in scope, so it ranks against everyone in the selection. It
 * is worked out once in the query rather than by the measure, which builds
 * the whole scored list again for every row. The organization is looked up
 * per person, over the one-directional `Audit_UserId` → `PersonId`
 * relationship, so it labels each row without narrowing the ranking.
 */
export function coworkCandidates() {
    return { connection, query, columnMetadata };
}

/**
 * True when every candidate, listed or not, has the same prompts-per-session
 * figure, so depth cannot separate anyone and breadth and agent use decide
 * the ranking alone. Tenants whose audit log records one prompt per session
 * always land here.
 */
export function isDepthUniform(table: DataTable): boolean {
    const index = table.columns.findIndex((column) => column.name === "Depths");
    return index >= 0 && table.rows[0]?.[index] === 1;
}
