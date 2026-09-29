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
    "[Cowork Users]": { name: "Cowork Users", displayName: "Cowork users", format: FORMAT_WHOLE },
    "[Cowork Sessions]": { name: "Cowork Sessions", displayName: "Cowork sessions", format: FORMAT_WHOLE },
    "[Graded Sessions]": { name: "Graded Sessions", displayName: "Graded sessions", format: FORMAT_WHOLE },
    "[Strong Fit Share]": { name: "Strong Fit Share", displayName: "Strong fit", format: FORMAT_PERCENT },
    "[Low Fit Share]": { name: "Low Fit Share", displayName: "Low fit", format: FORMAT_PERCENT },
    "[Cowork Hours]": { name: "Cowork Hours", displayName: "Hours of work", format: FORMAT_HOURS },
    "[Fit Notice]": { name: "Fit Notice", displayName: "Fit notice" },
};

/**
 * How well the work people hand to Cowork suits it.
 *
 * Each Cowork session is graded by the model's `Work Weight Grade`; sessions
 * the classifier could not place are left out of both shares rather than
 * counted as poor fits. `Fit Notice` is the model's own explanation when
 * there is too little detail to grade, and is shown verbatim.
 */
export function coworkFitSummary() {
    return { connection, query, columnMetadata };
}
