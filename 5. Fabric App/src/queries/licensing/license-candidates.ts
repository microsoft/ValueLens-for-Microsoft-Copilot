//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
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
};

/**
 * The next people to license, ranked at user grain.
 *
 * `License Priority Rank (Dynamic)` falls back to a per-organization rank when
 * organization is grouped, so the query groups by user and looks organization
 * up afterward.
 */
export function licenseCandidates() {
    return { connection, query, columnMetadata };
}
