//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./activation-summary.dax?raw";

/**
 * Column metadata keyed by the exact column name returned by the DAX query.
 * Verified against live output from `npx fabric-app-data query vl`.
 */
const columnMetadata: ColumnMetadataMap = {
    "[Licensed Active]": { name: "Licensed Active", displayName: "Active licensed users", format: FORMAT_WHOLE },
    "[Licensed Inactive]": { name: "Licensed Inactive", displayName: "Inactive licensed users", format: FORMAT_WHOLE },
    "[Licensed Total]": { name: "Licensed Total", displayName: "Licensed users", format: FORMAT_WHOLE },
    "[Licensed Active Pct]": { name: "Licensed Active Pct", displayName: "% active licensed", format: FORMAT_PERCENT },
    "[Unlicensed Active]": { name: "Unlicensed Active", displayName: "Active unlicensed users", format: FORMAT_WHOLE },
    "[Unlicensed Inactive]": { name: "Unlicensed Inactive", displayName: "Inactive unlicensed users", format: FORMAT_WHOLE },
    "[Unlicensed Total]": { name: "Unlicensed Total", displayName: "Unlicensed users", format: FORMAT_WHOLE },
    "[Unlicensed Active Pct]": { name: "Unlicensed Active Pct", displayName: "% active unlicensed", format: FORMAT_PERCENT },
    "[All Active]": { name: "All Active", displayName: "Active users", format: FORMAT_WHOLE },
    "[All Inactive]": { name: "All Inactive", displayName: "Inactive users", format: FORMAT_WHOLE },
    "[All Total]": { name: "All Total", displayName: "Total users", format: FORMAT_WHOLE },
    "[All Active Pct]": { name: "All Active Pct", displayName: "% active", format: FORMAT_PERCENT },
    "[Agent Active]": { name: "Agent Active", displayName: "Users with agent activity", format: FORMAT_WHOLE },
    "[Agent NotUsing]": { name: "Agent NotUsing", displayName: "Copilot users not using agents", format: FORMAT_WHOLE },
    "[Agent Active Pct]": { name: "Agent Active Pct", displayName: "% using agents", format: FORMAT_PERCENT },
    "[Headline Overall]": { name: "Headline Overall", displayName: "Overall" },
    "[Headline Licensed]": { name: "Headline Licensed", displayName: "Licensed" },
    "[Headline Unlicensed]": { name: "Headline Unlicensed", displayName: "Unlicensed" },
    "[Headline Agents]": { name: "Headline Agents", displayName: "Agents" },
};

/**
 * Every activation figure for all four cohorts in a single query.
 *
 * The equivalent Power BI page fires roughly thirty queries to populate the
 * same cards; consolidating into one `ROW()` keeps the screen to one round
 * trip.
 */
export function activationSummary() {
    return { connection, query, columnMetadata };
}
