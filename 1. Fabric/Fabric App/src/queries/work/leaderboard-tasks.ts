//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import { withCohortMeasures, type LeaderboardCohort } from "./leaderboard-cohorts";
import { LEADERBOARD_FIELDS, LEADERBOARD_LABEL_COLUMN, leaderboardMeasureMetadata } from "./leaderboard-people";
import template from "./leaderboard-tasks.dax?raw";

const AUDIT_TABLE = "Chat + Agent Interactions (Audit Logs)";

interface TaskLevels {
    /** Audit-log column for the outer rows. */
    group: string;
    /** Audit-log column for the rows inside each group. */
    leaf: string;
    /** Header for the grid's first column. */
    heading: string;
    /** The two levels as the report titles its table. */
    path: string;
    /** What the group rows are, for prose. */
    groupNoun: string;
    groupPlural: string;
    /** What the leaf rows are, for prose. */
    leafNoun: string;
    leafPlural: string;
}

/** What the report's right-hand table groups by: where the sessions happened, then what they did there. */
const APP_ACTIVITY: TaskLevels = {
    group: "AppHost",
    leaf: "Behavior_Enriched_Full",
    heading: "App / surface / Task Breakdown",
    path: "App / surface → Task Breakdown",
    groupNoun: "app or surface",
    groupPlural: "apps and surfaces",
    leafNoun: "Task Breakdown",
    leafPlural: "Task Breakdown",
};

/** Cowork happens in one surface, so the report groups its sessions by what the work was instead. */
const TASK_GROUP_CATEGORY: TaskLevels = {
    group: "Task Breakdown Group",
    leaf: "Task Breakdown Category",
    heading: "Task Category / Task Breakdown",
    path: "Task Category → Task Breakdown",
    groupNoun: "Task Category",
    groupPlural: "Task Categories",
    leafNoun: "Task Breakdown",
    leafPlural: "Task Breakdown",
};

function taskLevels(cohort: LeaderboardCohort): TaskLevels {
    return cohort === "cowork" ? TASK_GROUP_CATEGORY : APP_ACTIVITY;
}

/**
 * The report's right-hand Leaderboard table for one cohort: each app or
 * surface, then its Task Breakdown — or, for Cowork, each Task Category then
 * its Task Breakdown — with active users, sessions and sessions per user per
 * week.
 */
export function leaderboardTasks(cohort: LeaderboardCohort = "all") {
    const levels = taskLevels(cohort);
    const query = withCohortMeasures(template, cohort)
        .replaceAll("__GROUP__", levels.group)
        .replaceAll("__LEAF__", levels.leaf);
    const columnMetadata: ColumnMetadataMap = {
        [`${AUDIT_TABLE}[${levels.group}]`]: { name: `${AUDIT_TABLE}${levels.group}`, displayName: levels.groupNoun },
        [`${AUDIT_TABLE}[${levels.leaf}]`]: { name: `${AUDIT_TABLE}${levels.leaf}`, displayName: levels.leafNoun },
        ...leaderboardMeasureMetadata,
    };
    return { connection, query, columnMetadata, levels };
}

/** Group rows holding their leaves; a blank value reads as "Not recorded". */
export function toLeaderboardTaskTree(table: DataTable, levels: TaskLevels): RollupTree {
    return toRollupTree(table, {
        group: `${AUDIT_TABLE}${levels.group}`,
        leaf: `${AUDIT_TABLE}${levels.leaf}`,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: LEADERBOARD_LABEL_COLUMN,
        fields: LEADERBOARD_FIELDS,
        blankLabel: "Not recorded",
    });
}
