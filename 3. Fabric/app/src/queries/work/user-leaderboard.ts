//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./user-leaderboard.dax?raw";

/** The rollup flag `toRollupDataTables` splits the grand total out on. */
export const rollupFlagColumns = ["[IsTotal]"] as const;

/** Grid column ids for the two key columns, after `ColumnDef` name cleaning. */
export const ORGANIZATION_COLUMN = "Chat + Agent Org DataOrganization";
export const USER_COLUMN = "Chat + Agent Interactions (Audit Logs)Audit_UserId";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": {
        name: ORGANIZATION_COLUMN,
        displayName: "Organization",
    },
    "Chat + Agent Interactions (Audit Logs)[Audit_UserId]": {
        name: USER_COLUMN,
        displayName: "User",
    },
    "[All Tasks]": { name: "All Tasks", displayName: "All tasks", format: FORMAT_WHOLE },
    "[Licensed Tasks]": { name: "Licensed Tasks", displayName: "Licensed tasks", format: FORMAT_WHOLE },
    "[Unlicensed Tasks]": { name: "Unlicensed Tasks", displayName: "Unlicensed tasks", format: FORMAT_WHOLE },
    "[Agent Tasks]": { name: "Agent Tasks", displayName: "Agent tasks", format: FORMAT_WHOLE },
    "[Active Days]": { name: "Active Days", displayName: "Active days", format: FORMAT_RATE },
};

/**
 * One row per person with every cohort's task count, plus a grand-total row
 * the grid pins to the bottom.
 *
 * The report repeats the same table four times, once per cohort, across four
 * bookmarks. Here every cohort rides along on the same rows and the toggle
 * only changes which columns the grid shows.
 *
 * `ROLLUPGROUP` collapses organization and user into a single grouping level,
 * so the rollup emits detail rows and exactly one grand total — no
 * per-organization subtotals, which `toRollupDataTables` deliberately refuses.
 */
export function userLeaderboard() {
    return { connection, query, columnMetadata, rollupFlagColumns };
}
