//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import type { LoadStatus } from "@/lib/freshness";
import { readText, toRecords } from "@/lib/summary-row";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./load-status.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Activity]": { name: "Activity", displayName: "Load" },
    "[Source]": { name: "Source", displayName: "Source" },
    "[Status]": { name: "Status", displayName: "Status" },
    "[Reason]": { name: "Reason", displayName: "Why" },
};

/**
 * How each load went on the latest pipeline run, from the `Load Log` table
 * (dbo.load_log), whatever the filters say. A model without the table, such
 * as one deployed before it was added, fails this query alone.
 */
export function loadStatus() {
    return { connection, query, columnMetadata };
}

/** The query's rows as load outcomes, skipping any without a load or status. */
export function readLoadStatus(table: QueryTable): LoadStatus[] {
    return toRecords(table).flatMap((row) => {
        const activity = readText(row, "[Activity]");
        const status = readText(row, "[Status]");
        if (!activity || !status) return [];
        return [{ activity, status, source: readText(row, "[Source]") ?? activity, reason: readText(row, "[Reason]") }];
    });
}
