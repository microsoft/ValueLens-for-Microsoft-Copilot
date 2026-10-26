//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./agent-functions.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Agent Key]": { name: "Agent Key" },
    "[Leader Count]": { name: "Leader Count", format: FORMAT_WHOLE },
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Registry Id]": { name: "Registry Id", displayName: "Registry ID" },
    "[Functions]": { name: "Functions", displayName: "Job functions", format: FORMAT_WHOLE },
};

/**
 * The agents used by the most job functions, from the org directory's
 * Function column, with that count. Agents are named as on the agent
 * leaderboard. At most two winners return, with the complete Leader Count
 * for ties. A tenant whose directory has no functions returns no rows.
 */
export function agentFunctions() {
    return { connection, query, columnMetadata };
}
