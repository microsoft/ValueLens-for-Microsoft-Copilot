//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE, TOTAL_COLUMN } from "../shared";
import query from "./license-candidates.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Rank]": { name: "Rank", displayName: "Rank", format: FORMAT_WHOLE },
    "[User]": { name: "User", displayName: "User" },
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[Priority Score]": { name: "Priority Score", displayName: "Priority score", format: FORMAT_WHOLE },
    "[Sessions Per Week]": {
        name: "Sessions Per Week",
        displayName: "Sessions per week",
        format: FORMAT_RATE,
    },
    "[Active Days Per Week]": {
        name: "Active Days Per Week",
        displayName: "Active days per week",
        format: FORMAT_RATE,
    },
    ...TOTAL_COLUMN,
};

/**
 * The next people to license, ranked at user grain: the first
 * `LIST_LIMIT` of them, with `[Total]` counting them all.
 *
 * The rank is the model's `License Priority Rank (Dynamic)` at user level,
 * worked out once in the query from each person's score rather than by the
 * measure, which scores everyone again for every row. Organization is looked
 * up afterward, so it labels each row without narrowing the ranking.
 */
export function licenseCandidates() {
    return { connection, query, columnMetadata };
}
