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
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Registry Id]": { name: "Registry Id", displayName: "Registry ID" },
    "[Functions]": { name: "Functions", displayName: "Job functions", format: FORMAT_WHOLE },
};

/**
 * How many job functions used each agent with sessions, from the org
 * directory's Function column. Agents are named as on the agent
 * leaderboard. A tenant whose directory has no functions returns zeros.
 */
export function agentFunctions() {
    return { connection, query, columnMetadata };
}
