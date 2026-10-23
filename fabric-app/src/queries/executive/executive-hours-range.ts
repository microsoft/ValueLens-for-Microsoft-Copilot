//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS } from "../shared";
import query from "./executive-hours-range.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Hours Conservative]": { name: "Hours Conservative", displayName: "Conservative hours", format: FORMAT_HOURS },
    "[Hours Optimistic]": { name: "Hours Optimistic", displayName: "Optimistic hours", format: FORMAT_HOURS },
};

/**
 * The range under the executive summary's hours: expert-equivalent hours at
 * Conservative and at Optimistic effort. It is asked beside
 * `executiveSummary`, under the same filters, so the summary's figures don't
 * wait for it.
 */
export function executiveHoursRange() {
    return { connection, query, columnMetadata };
}
