//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./work-summary.dax?raw";

/**
 * Column metadata keyed by the exact column name returned by the DAX query.
 * Verified against live output from `npx fabric-app-data query vl`.
 */
const columnMetadata: ColumnMetadataMap = {
    "[All Tasks]": { name: "All Tasks", displayName: "Tasks", format: FORMAT_WHOLE },
    "[Licensed Tasks]": { name: "Licensed Tasks", displayName: "Licensed tasks", format: FORMAT_WHOLE },
    "[Unlicensed Tasks]": { name: "Unlicensed Tasks", displayName: "Unlicensed tasks", format: FORMAT_WHOLE },
    "[Agent Tasks]": { name: "Agent Tasks", displayName: "Agent tasks", format: FORMAT_WHOLE },
    "[All Users]": { name: "All Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Licensed Users]": { name: "Licensed Users", displayName: "Active licensed users", format: FORMAT_WHOLE },
    "[Unlicensed Users]": { name: "Unlicensed Users", displayName: "Active unlicensed users", format: FORMAT_WHOLE },
    "[Agent Users]": { name: "Agent Users", displayName: "Active agent users", format: FORMAT_WHOLE },
    "[All Rate]": { name: "All Rate", displayName: "Tasks per active user", format: FORMAT_RATE },
    "[Licensed Rate]": { name: "Licensed Rate", displayName: "Tasks per licensed user", format: FORMAT_RATE },
    "[Unlicensed Rate]": { name: "Unlicensed Rate", displayName: "Tasks per unlicensed user", format: FORMAT_RATE },
    "[Agent Rate]": { name: "Agent Rate", displayName: "Tasks per agent user", format: FORMAT_RATE },
    "[Top Value Outcome]": { name: "Top Value Outcome", displayName: "Most common benefit" },
    "[Licensed Utilisation]": {
        name: "Licensed Utilisation",
        displayName: "% of licences active",
        format: FORMAT_PERCENT,
    },
};

/**
 * Every headline figure on the Work destination, for all four cohorts, in a
 * single round trip.
 */
export function workSummary() {
    return { connection, query, columnMetadata };
}
