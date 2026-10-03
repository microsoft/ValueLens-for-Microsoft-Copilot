//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import {
    DEFAULT_ORG_ATTRIBUTE,
    describeOrgAttribute,
    withOrgAttribute,
    type OrgAttribute,
} from "@/lib/org-attribute";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import { withCohortMeasures, type LeaderboardCohort } from "./leaderboard-cohorts";
import template from "./leaderboard-people.dax?raw";

const ORG_COLUMN = "Chat + Agent Org DataOrganization";
const USER_COLUMN = "Chat + Agent Interactions (Audit Logs)Audit_UserId";

/** The grid's first column in both leaderboard trees: the group on group rows, the leaf on leaf rows. */
export const LEADERBOARD_LABEL_COLUMN = "Who";
export const LEADERBOARD_FIELDS = ["Active Users", "Sessions", "Sessions Per User Per Week"] as const;

const measureMetadata: ColumnMetadataMap = {
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[Active Users]": { name: "Active Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Sessions Per User Per Week]": {
        name: "Sessions Per User Per Week",
        displayName: "Sessions / user / week",
        format: FORMAT_RATE,
    },
};

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": { name: ORG_COLUMN, displayName: "Organization" },
    "Chat + Agent Interactions (Audit Logs)[Audit_UserId]": { name: USER_COLUMN, displayName: "User" },
    ...measureMetadata,
};

/** Shared with the tasks query, which returns the same rollup flags and measures. */
export const leaderboardMeasureMetadata = measureMetadata;

/**
 * The report's "Organization → User" leaderboard for one cohort: each org
 * group, then its people, with active users, sessions and sessions per user
 * per week. Pass another org attribute to group by that column instead.
 */
export function leaderboardPeople(
    cohort: LeaderboardCohort = "all",
    attribute: OrgAttribute = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
) {
    return withOrgAttribute({ connection, query: withCohortMeasures(template, cohort), columnMetadata }, attribute);
}

/** Org rows holding their people; blank org values read as `blankLabel`. */
export function toLeaderboardPeopleTree(table: DataTable, blankLabel: string): RollupTree {
    return toRollupTree(table, {
        group: ORG_COLUMN,
        leaf: USER_COLUMN,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: LEADERBOARD_LABEL_COLUMN,
        fields: LEADERBOARD_FIELDS,
        blankLabel,
    });
}
