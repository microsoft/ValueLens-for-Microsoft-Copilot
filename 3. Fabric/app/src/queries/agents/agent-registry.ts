//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./agent-registry.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Type]": { name: "Type", displayName: "Type" },
    "[Creator]": { name: "Creator", displayName: "Creator" },
    "[Lifecycle Order]": { name: "Lifecycle Order", displayName: "Lifecycle order" },
    "[Lifecycle]": { name: "Lifecycle", displayName: "Lifecycle" },
    "[Usage Review]": { name: "Usage Review", displayName: "Usage review" },
    "[Users]": { name: "Users", displayName: "Users", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
};

/**
 * One row per registered agent, keyed on `Title ID` so two agents sharing a
 * display name stay separate rows. Usage comes through the registry join, so
 * it is blank for any agent the audit log never matched.
 */
export function agentRegistry() {
    return { connection, query, columnMetadata };
}
