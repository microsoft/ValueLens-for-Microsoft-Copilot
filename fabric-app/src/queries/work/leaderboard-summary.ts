//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnDef } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import { leaderboardMeasures, leaderboardSummaryColumns, type LeaderboardCohort } from "./leaderboard-cohorts";
import template from "./leaderboard-summary.dax?raw";

function entry(column: string, displayName: string, format?: string): [string, ColumnDef] {
    const name = column.slice(1, -1);
    return [column, format ? { name, displayName, format } : { name, displayName }];
}

interface Card {
    column: string;
    measure: string;
    displayName: string;
    format: string;
}

/** The card each of the report's bookmarks adds to the four every cohort shares. */
const EXTRA_CARD: Record<LeaderboardCohort, Card | undefined> = {
    all: undefined,
    licensed: {
        column: "[Licence Utilisation]",
        measure: "% Active Licensed Users",
        displayName: "License utilization",
        format: FORMAT_PERCENT,
    },
    unlicensed: { column: "[Unlicensed Tasks]", measure: "Unlicensed AI Tasks", displayName: "AI tasks", format: FORMAT_WHOLE },
    agents: { column: "[Agent Tasks]", measure: "Agent AI Tasks", displayName: "AI tasks", format: FORMAT_WHOLE },
    cowork: { column: "[Cowork Tasks]", measure: "Cowork AI Tasks", displayName: "AI tasks", format: FORMAT_WHOLE },
};

function cards(cohort: LeaderboardCohort): Card[] {
    const columns = leaderboardSummaryColumns(cohort);
    const measures = leaderboardMeasures(cohort);
    const extra = EXTRA_CARD[cohort];
    return [
        { column: columns.users, measure: measures.users, displayName: "Active users", format: FORMAT_WHOLE },
        { column: columns.sessions, measure: measures.sessions, displayName: "Sessions", format: FORMAT_WHOLE },
        { column: columns.perUser, measure: measures.perUser, displayName: "Sessions / user", format: FORMAT_RATE },
        { column: columns.perWeek, measure: measures.perWeek, displayName: "Sessions / user / week", format: FORMAT_RATE },
        ...(extra ? [extra] : []),
    ];
}

/**
 * The cards above the Leaderboard for one cohort: active users, sessions,
 * sessions per user and per user per week, plus the bookmark's extra card —
 * license utilization or AI tasks. Only the cohort on screen is asked for:
 * all five at once took about twice as long at 20,000 people. Read it with
 * `toSummaryRow`; `leaderboardSummaryColumns` names its columns.
 */
export function leaderboardSummary(cohort: LeaderboardCohort) {
    const shown = cards(cohort);
    const row = shown.map(({ column, measure }) => `"${column.slice(1, -1)}", [${measure}]`).join(",\n        ");
    const columnMetadata: ColumnMetadataMap = Object.fromEntries(
        shown.map(({ column, displayName, format }) => entry(column, displayName, format)),
    );
    return { connection, query: template.replace("__CARDS__", row), columnMetadata };
}
