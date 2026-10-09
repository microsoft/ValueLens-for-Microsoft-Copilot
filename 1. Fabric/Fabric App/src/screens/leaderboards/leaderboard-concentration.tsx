//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { ConcentrationPanel } from "@/components/concentration-panel";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useTableQuery } from "@/hooks/use-table-query";
import { personValues } from "@/lib/concentration";
import { LEADERBOARD_USER_COLUMN, leaderboardPeople, type LeaderboardCohort } from "@/queries/work";

/**
 * How much of the ranked cohort's sessions the busiest people account for,
 * read from the same per-person rows as the user breakdown.
 */
export function LeaderboardConcentration({ cohort, noun }: { cohort: LeaderboardCohort; noun: string }) {
    const org = useOrgAttribute();
    const source = useMemo(() => leaderboardPeople(cohort, org), [cohort, org]);
    const result = useTableQuery(source);
    const values = useMemo(
        () => personValues(result.table, LEADERBOARD_USER_COLUMN, "Sessions", ["Is Grand Total", "Is Group Total"]),
        [result.table],
    );

    return (
        <ConcentrationPanel
            result={result}
            values={values}
            noun={noun}
            title={`How concentrated ${noun} are`}
            subtitle={`Each person's share of ${noun}, busiest first, for the dates and filters selected`}
            emptyTitle="Nobody to rank"
            emptyDescription={`No one had ${noun} in this selection.`}
        />
    );
}
