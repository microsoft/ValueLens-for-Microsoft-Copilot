//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./governance-owners.dax?raw";
import spec from "./governance-owners.json";

const columnMetadata: ColumnMetadataMap = {
    "[Status Order]": { name: "Status Order", displayName: "Status order" },
    "[Owner Status]": { name: "Owner Status", displayName: "Owner" },
    "[Agents]": { name: "Agents", displayName: "Agents", format: FORMAT_WHOLE },
};

/** The statuses the query returns, in its order; the screen pins a tone to each. */
export const OWNER_STATUSES = [
    "Owner active",
    "Owner disabled",
    "Owner not found",
    "No owner on record",
    "Not checked",
] as const;

/**
 * Whether each tenant-built agent still has someone accountable for it: the
 * owner's Entra account is active, disabled or gone, or the registry names
 * no owner at all. `Not checked` covers registries loaded without the
 * ingester's owner-account check, such as a CSV export.
 */
export function governanceOwners() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
