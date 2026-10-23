//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./license-dormancy.dax?raw";
import spec from "./license-dormancy.json";

const columnMetadata: ColumnMetadataMap = {
    "[Dormancy Bucket Order]": {
        name: "Dormancy Bucket Order",
        displayName: "Dormancy bucket order",
        format: FORMAT_WHOLE,
    },
    "[Dormancy Bucket]": { name: "Dormancy Bucket", displayName: "Dormancy bucket" },
    "[Licensed Users]": { name: "Licensed Users", displayName: "Licensed users", format: FORMAT_WHOLE },
};

/**
 * Licensed users by roster dormancy bucket.
 *
 * The report treats this as license inventory, not dated activity, so the
 * stage ignores date and organization slicers and says so when they are set.
 */
export function licenseDormancy() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
