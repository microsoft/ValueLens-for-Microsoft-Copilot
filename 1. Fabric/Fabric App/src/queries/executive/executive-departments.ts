//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./executive-departments.dax?raw";

export const DEPARTMENT_COLUMN = "Chat + Agent Org DataOrganization";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": { name: DEPARTMENT_COLUMN, displayName: "Organization" },
    "[Licensed Seats]": { name: "Licensed Seats", displayName: "Licensed seats", format: FORMAT_WHOLE },
    "[Seats In Use Pct]": { name: "Seats In Use Pct", displayName: "Seats in use", format: FORMAT_PERCENT },
    "[Habit Pct]": { name: "Habit Pct", displayName: "Habit rate", format: FORMAT_PERCENT },
    "[Skills Per Person]": { name: "Skills Per Person", displayName: "Unique skills per person", format: FORMAT_RATE },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[People]": { name: "People", displayName: "People with a task", format: FORMAT_WHOLE },
    "[Hours Per Seat Month]": { name: "Hours Per Seat Month", displayName: "Hours per seat a month", format: FORMAT_HOURS },
};

/**
 * Where Copilot is landing: each organization's seats, habit, breadth of use
 * and expert-equivalent hours, ranked by hours per licensed seat a month so
 * departments of different sizes compare fairly.
 *
 * Authored against `Organization`; bind it to the chosen org column with
 * `withOrgAttribute`.
 */
export function executiveDepartments() {
    return { connection, query, columnMetadata };
}
