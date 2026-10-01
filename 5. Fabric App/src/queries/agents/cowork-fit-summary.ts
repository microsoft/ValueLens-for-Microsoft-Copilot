//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./cowork-fit-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Cowork Sessions]": { name: "Cowork Sessions", displayName: "Cowork sessions", format: FORMAT_WHOLE },
    "[Tasks Completed]": { name: "Tasks Completed", displayName: "Tasks completed", format: FORMAT_WHOLE },
    "[Active Days Per User]": {
        name: "Active Days Per User",
        displayName: "Active days per user",
        format: FORMAT_HOURS,
    },
    "[Expert Hours]": { name: "Expert Hours", displayName: "Expert equivalent hours", format: FORMAT_HOURS },
    "[Strong Fit Share]": { name: "Strong Fit Share", displayName: "Strong fit", format: FORMAT_PERCENT },
    "[Worth A Look Share]": { name: "Worth A Look Share", displayName: "Worth a look", format: FORMAT_PERCENT },
    "[Fit Notice]": { name: "Fit Notice", displayName: "Fit notice" },
};

/**
 * The six headline cards of the report's Cowork fit page, plus its rule notice.
 *
 * Each Cowork session is graded by the model's `Work Weight Grade`; sessions
 * too light to grade are left out of both shares rather than counted as poor
 * fits. `Fit Notice` is the model's own statement of the grading rules and how
 * many sessions it graded, shown verbatim. `Active Days Per User` and
 * `Expert Hours` carry one decimal place, as the report shows them.
 */
export function coworkFitSummary() {
    return { connection, query, columnMetadata };
}
