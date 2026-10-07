//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./governance-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Tenant Agents]": { name: "Tenant Agents", displayName: "Built in this tenant", format: FORMAT_WHOLE },
    "[Needs Review]": { name: "Needs Review", displayName: "Need a review", format: FORMAT_WHOLE },
    "[Owner Left]": { name: "Owner Left", displayName: "Owner has left", format: FORMAT_WHOLE },
    "[No Owner]": { name: "No Owner", displayName: "No owner on record", format: FORMAT_WHOLE },
    "[Org Wide Org Data]": {
        name: "Org Wide Org Data",
        displayName: "Org-wide with org data",
        format: FORMAT_WHOLE,
    },
    "[Shared Unused]": { name: "Shared Unused", displayName: "Shared, no recorded use", format: FORMAT_WHOLE },
    "[Org Wide]": { name: "Org Wide", displayName: "Shared org-wide", format: FORMAT_WHOLE },
    "[Owners Checked]": { name: "Owners Checked", displayName: "Owners checked", format: FORMAT_WHOLE },
};

/**
 * The tenant-built agents and how many carry each governance flag.
 *
 * The flags themselves are the model's `Governance Flags` column, which only
 * marks tenant-built agents an admin hasn't blocked; the counts here read
 * that one column so the page and the report can never disagree on what a
 * flag means. `Owners Checked` is zero when the ingester's owner-account
 * check is off or the registry came from a CSV, so the page can say the
 * owner figures are missing rather than reporting that nobody has left.
 */
export function governanceSummary() {
    return { connection, query, columnMetadata };
}
