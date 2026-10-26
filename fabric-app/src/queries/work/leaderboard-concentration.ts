//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
    DEFAULT_ORG_ATTRIBUTE,
    describeOrgAttribute,
    withOrgAttribute,
    type OrgAttribute,
} from "@/lib/org-attribute";
import { CONCENTRATION_COLUMNS, connection } from "../shared";
import { withCohortMeasures, type LeaderboardCohort } from "./leaderboard-cohorts";
import template from "./leaderboard-concentration.dax?raw";

/**
 * How much of one cohort's sessions the busiest 1%, 5% and 25% of people
 * account for, worked out over every person in the "Organization → User"
 * table rather than the top of it. It returns only those three cuts, not
 * the curve's, so read the rows with `readConcentrationSlices`.
 */
export function leaderboardConcentration(
    cohort: LeaderboardCohort = "all",
    attribute: OrgAttribute = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
) {
    return withOrgAttribute(
        { connection, query: withCohortMeasures(template, cohort), columnMetadata: CONCENTRATION_COLUMNS },
        attribute,
    );
}