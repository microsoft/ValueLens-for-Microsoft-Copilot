//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./governance-review-queue.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Registry Id]": { name: "Registry Id", displayName: "Registry ID" },
    "[Type]": { name: "Type", displayName: "Agent type" },
    "[Creator]": { name: "Creator", displayName: "Creator" },
    "[Sharing Scope]": { name: "Sharing Scope", displayName: "Shared with" },
    "[Data Access]": { name: "Data Access", displayName: "Can read" },
    "[Users]": { name: "Users", displayName: "Users", format: FORMAT_WHOLE },
    "[Owner Account]": { name: "Owner Account", displayName: "Owner account" },
    "[Flag Count]": { name: "Flag Count", displayName: "Flags raised", format: FORMAT_WHOLE },
    "[Flags]": { name: "Flags", displayName: "Why it's here" },
};

/**
 * Every tenant-built agent carrying at least one governance flag, the most
 * flags first and then the most users, since an agent many people rely on
 * is the one to sort out before it breaks.
 */
export function governanceReviewQueue() {
    return { connection, query, columnMetadata };
}
