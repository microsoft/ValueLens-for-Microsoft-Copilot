//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./m365-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[People Active]": { name: "People Active", displayName: "People active", format: FORMAT_WHOLE },
    "[Days Loaded]": { name: "Days Loaded", displayName: "Days loaded", format: FORMAT_WHOLE },
    "[First Date]": { name: "First Date", displayName: "First date" },
    "[Last Date]": { name: "Last Date", displayName: "Last date" },
    "[Active Days Per Week]": { name: "Active Days Per Week", displayName: "Active days per week", format: FORMAT_RATE },
    "[Workloads Per Active Day]": {
        name: "Workloads Per Active Day",
        displayName: "Workloads per active day",
        format: FORMAT_RATE,
    },
    "[Meetings Per Week]": { name: "Meetings Per Week", displayName: "Meetings per week", format: FORMAT_RATE },
    "[Call Hours Per Week]": { name: "Call Hours Per Week", displayName: "Call and meeting hours per week", format: FORMAT_HOURS },
    "[Emails Sent Per Week]": { name: "Emails Sent Per Week", displayName: "Emails sent per week", format: FORMAT_RATE },
    "[Chats Per Week]": { name: "Chats Per Week", displayName: "Chat messages per week", format: FORMAT_RATE },
};

/**
 * The shape of an average working week on Microsoft 365. Weekly figures are
 * per active person, over the days loaded in the selection, so a short date
 * range doesn't read as a quiet one.
 */
export function m365Summary() {
    return { connection, query, columnMetadata };
}
