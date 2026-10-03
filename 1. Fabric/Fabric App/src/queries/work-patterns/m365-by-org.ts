//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./m365-by-org.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[People Active]": { name: "People Active", displayName: "Active on Microsoft 365", format: FORMAT_WHOLE },
    "[Copilot Users]": { name: "Copilot Users", displayName: "Using Copilot", format: FORMAT_WHOLE },
    "[Copilot Reach]": { name: "Copilot Reach", displayName: "Copilot reach", format: FORMAT_PERCENT },
    "[Active Days Per Week]": { name: "Active Days Per Week", displayName: "Active days per week", format: FORMAT_RATE },
    "[Meetings Per Week]": { name: "Meetings Per Week", displayName: "Meetings per week", format: FORMAT_RATE },
    "[Emails Sent Per Week]": { name: "Emails Sent Per Week", displayName: "Emails sent per week", format: FORMAT_RATE },
};

/**
 * Each organization's working week on Microsoft 365, beside how far Copilot
 * has reached into it. People with no organization in the org data are left
 * out rather than pooled into a blank row.
 */
export function m365ByOrg() {
    return { connection, query, columnMetadata };
}
