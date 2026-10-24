//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./executive-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Tasks]": { name: "Tasks", displayName: "Tasks delivered", format: FORMAT_WHOLE },
    "[People]": { name: "People", displayName: "People with a task", format: FORMAT_WHOLE },
    "[Weeks]": { name: "Weeks", displayName: "Weeks", format: FORMAT_WHOLE },
    "[Skills Available]": { name: "Skills Available", displayName: "Kinds of work", format: FORMAT_WHOLE },
    "[Licensed Seats]": { name: "Licensed Seats", displayName: "Licensed seats", format: FORMAT_WHOLE },
    "[Seats In Use]": { name: "Seats In Use", displayName: "Seats in use", format: FORMAT_WHOLE },
    "[Seats In Use Pct]": { name: "Seats In Use Pct", displayName: "Licensed seats in use", format: FORMAT_PERCENT },
    "[Unlicensed Users]": { name: "Unlicensed Users", displayName: "Unlicensed users", format: FORMAT_WHOLE },
    "[Habit Month]": { name: "Habit Month", displayName: "Habit month", format: "mmm yyyy" },
    "[Habitual Pct]": { name: "Habitual Pct", displayName: "Habitual", format: FORMAT_PERCENT },
    "[Power Pct]": { name: "Power Pct", displayName: "Power", format: FORMAT_PERCENT },
    "[Agent Users]": { name: "Agent Users", displayName: "Agent users", format: FORMAT_WHOLE },
    "[Agent Hours]": { name: "Agent Hours", displayName: "Agent hours", format: FORMAT_HOURS },
    "[Agents In Use]": { name: "Agents In Use", displayName: "Agents in use", format: FORMAT_WHOLE },
    "[Satisfaction]": { name: "Satisfaction", displayName: "Satisfaction", format: FORMAT_PERCENT },
    "[Feedback]": { name: "Feedback", displayName: "Ratings", format: FORMAT_WHOLE },
    "[People With Organization]": {
        name: "People With Organization",
        displayName: "People with an organization",
        format: FORMAT_WHOLE,
    },
};

/**
 * The executive summary's headline figures in one round trip: the work done,
 * how many people use Copilot, how far it has become habit, and how they
 * rate it. Hours are at Typical effort; `executiveHoursRange` has the
 * Conservative to Optimistic range, asked beside this.
 */
export function executiveSummary() {
    return { connection, query, columnMetadata };
}
