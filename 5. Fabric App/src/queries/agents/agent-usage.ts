//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./agent-usage.dax?raw";
import spec from "./agent-usage.json";

const columnMetadata: ColumnMetadataMap = {
    "[Agent]": { name: "Agent", displayName: "Agent" },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Users]": { name: "Users", displayName: "Users", format: FORMAT_WHOLE },
    "[Return Rate]": { name: "Return Rate", displayName: "Came back", format: FORMAT_PERCENT },
    "[Organizations]": { name: "Organizations", displayName: "Organizations", format: FORMAT_WHOLE },
};

/**
 * The fifteen busiest agents by session count, named as the audit log names
 * them.
 *
 * This reads the agent name straight off the interaction rows rather than
 * through the registry, so it still works when the registry join does not —
 * which, in tenants where the two use different identifiers, is the only way
 * to see which agents people actually use.
 */
export function agentUsage() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
