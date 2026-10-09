//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./m365-activity-freshness.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Last Date]": { name: "Last Date", displayName: "Microsoft 365 activity to" },
};

/** The last day of Microsoft 365 activity loaded, whatever the filters say. */
export function m365ActivityFreshness() {
    return { connection, query, columnMetadata };
}