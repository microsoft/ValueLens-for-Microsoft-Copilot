//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnDef } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import { leaderboardCohorts, leaderboardSummaryColumns } from "./leaderboard-cohorts";
import query from "./leaderboard-summary.dax?raw";

function entry(column: string, displayName: string, format?: string): [string, ColumnDef] {
    const name = column.slice(1, -1);
    return [column, format ? { name, displayName, format } : { name, displayName }];
}

const columnMetadata: ColumnMetadataMap = Object.fromEntries([
    ...leaderboardCohorts.flatMap(({ id }) => {
        const columns = leaderboardSummaryColumns(id);
        return [
            entry(columns.users, "Active users", FORMAT_WHOLE),
            entry(columns.sessions, "Sessions", FORMAT_WHOLE),
            entry(columns.perUser, "Sessions / user", FORMAT_RATE),
            entry(columns.perWeek, "Sessions / user / week", FORMAT_RATE),
        ];
    }),
    entry("[Licence Utilisation]", "License utilization", FORMAT_PERCENT),
    entry("[Unlicensed Tasks]", "AI tasks", FORMAT_WHOLE),
    entry("[Agent Tasks]", "AI tasks", FORMAT_WHOLE),
    entry("[Agent Return Rate]", "Return rate (2+ sessions)", FORMAT_PERCENT),
    entry("[Agent With Most Users]", "Agent with most users"),
    entry("[Top Agent Builder Creator]", "Top Agent Builder creator (by users)"),
    entry("[Cowork Tasks]", "AI tasks", FORMAT_WHOLE),
]);

/**
 * The cards above the Leaderboard for every cohort in one row: active users,
 * sessions, sessions per user and per user per week, plus each bookmark's
 * extra cards — license utilization, AI tasks, the agent return rate, the
 * agent with most users and the top Agent Builder creator. Read it with
 * `toSummaryRow`; `leaderboardSummaryColumns` names one cohort's columns.
 * The two named cards list every name on a tie, one per line.
 */
export function leaderboardSummary() {
    return { connection, query, columnMetadata };
}
