//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./agent-activity-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Agent Users]": { name: "Agent Users", displayName: "Agent users", format: FORMAT_WHOLE },
    "[Agent User Share]": {
        name: "Agent User Share",
        displayName: "% of active users using agents",
        format: FORMAT_PERCENT,
    },
    "[Agent Sessions]": { name: "Agent Sessions", displayName: "Agent sessions", format: FORMAT_WHOLE },
    "[Sessions Per User]": {
        name: "Sessions Per User",
        displayName: "Sessions per agent user",
        format: FORMAT_RATE,
    },
    "[Return Rate]": { name: "Return Rate", displayName: "Came back", format: FORMAT_PERCENT },
};

/**
 * Headline agent usage as the audit log records it: who used an agent, how
 * often, and whether they came back for a second session.
 */
export function agentActivitySummary() {
    return { connection, query, columnMetadata };
}
