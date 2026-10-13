//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./executive-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Hours Conservative]": { name: "Hours Conservative", displayName: "Conservative hours", format: FORMAT_HOURS },
    "[Hours Optimistic]": { name: "Hours Optimistic", displayName: "Optimistic hours", format: FORMAT_HOURS },
    "[Tasks]": { name: "Tasks", displayName: "Tasks delivered", format: FORMAT_WHOLE },
    "[People]": { name: "People", displayName: "People with a task", format: FORMAT_WHOLE },
    "[Weeks]": { name: "Weeks", displayName: "Weeks", format: FORMAT_WHOLE },
    "[Skills Per Person]": { name: "Skills Per Person", displayName: "Unique skills per person", format: FORMAT_RATE },
    "[Skills In Use]": { name: "Skills In Use", displayName: "Kinds of work in use", format: FORMAT_WHOLE },
    "[Skills Available]": { name: "Skills Available", displayName: "Kinds of work", format: FORMAT_WHOLE },
    "[Broad Users Pct]": { name: "Broad Users Pct", displayName: "Broad users", format: FORMAT_PERCENT },
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
    "[Agent With Most Users]": { name: "Agent With Most Users", displayName: "Agent with the most users" },
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
 * how broadly people use Copilot, how far it has become habit, and how they
 * rate it. Hours are at Typical effort, with Conservative and Optimistic as
 * the range.
 *
 * `Agent With Most Users` lists every agent tied for the most users, one per
 * line, so the screen can say when there is a tie.
 */
export function executiveSummary() {
    return { connection, query, columnMetadata };
}
