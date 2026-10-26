//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./value-by-habit.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Month]": { name: "Month", displayName: "Month", format: "mmmm yyyy" },
    "[Cohort]": { name: "Cohort", displayName: "Habit" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Count]": { name: "Count", displayName: "Busiest people", format: FORMAT_WHOLE },
    "[Cumulative]": { name: "Cumulative", displayName: "Their hours", format: FORMAT_HOURS },
    "[Total]": { name: "Total", displayName: "Total hours", format: FORMAT_HOURS },
};

/**
 * Expert-equivalent hours in the last full month by each person's habit
 * that month (Power, Habitual, Developing, Beginner): one row per habit with
 * its people and their hours. Habits count distinct active days, as the
 * Adoption page does. Beside them come the cut rows `readConcentration`
 * reads, for how much of the hours the busiest people account for, with
 * `People` then counting everyone with hours. The hours follow the Effort
 * Scenario, which callers apply as a filter.
 */
export function valueByHabit() {
    return { connection, query, columnMetadata };
}