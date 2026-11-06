//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./agent-value.dax?raw";

export const AGENT_NAME_COLUMN = "Chat + Agent Interactions (Audit Logs)AgentName";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[AgentName]": {
        name: AGENT_NAME_COLUMN,
        displayName: "Agent",
    },
    "[Active Agent Users]": {
        name: "Active Agent Users",
        displayName: "Active users",
        format: FORMAT_WHOLE,
    },
    "[Observed Agent Sessions]": {
        name: "Observed Agent Sessions",
        displayName: "Observed sessions",
        format: FORMAT_WHOLE,
    },
    "[Expert Equivalent Hours]": {
        name: "Expert Equivalent Hours",
        displayName: "Expert-equivalent hours",
        format: FORMAT_HOURS,
    },
    "[AI Assisted Value]": { name: "AI Assisted Value", displayName: "Estimated value", format: FORMAT_WHOLE },
};

/**
 * Agent-level contribution to the estimate.
 *
 * A Copilot-chat-only slice should have no rows here. The query keeps the
 * report's agent activity filter as a real DAX filter so the shared Activity
 * slicer can intentionally blank the table when it is set to Copilot chat.
 */
export function agentValue() {
    return { connection, query, columnMetadata };
}
