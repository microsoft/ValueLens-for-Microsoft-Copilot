//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./audit-log-freshness.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Last Date]": { name: "Last Date", displayName: "Audit log to" },
};

/**
 * The last day the audit log has Copilot Chat or agent interactions for,
 * whatever the filters say: freshness is about the data, not the selection.
 */
export function auditLogFreshness() {
    return { connection, query, columnMetadata };
}