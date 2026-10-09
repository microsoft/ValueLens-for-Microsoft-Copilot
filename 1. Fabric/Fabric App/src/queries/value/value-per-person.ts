//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./value-per-person.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Month]": { name: "Month", displayName: "Month", format: "mmmm yyyy" },
    "[User]": { name: "User", displayName: "User" },
    "[Active Days]": { name: "Active Days", displayName: "Active days", format: FORMAT_WHOLE },
    "[Cohort]": { name: "Cohort", displayName: "Habit" },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
};

/**
 * Expert-equivalent hours per person in the last full month, with each
 * person's habit (Power, Habitual, Developing, Beginner) for that month.
 * Habits count distinct active days, as the Adoption page does. The hours
 * follow the Effort Scenario, which callers apply as a filter.
 */
export function valuePerPerson() {
    return { connection, query, columnMetadata };
}
