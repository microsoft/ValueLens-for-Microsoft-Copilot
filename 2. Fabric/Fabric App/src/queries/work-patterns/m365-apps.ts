//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./m365-apps.dax?raw";
import spec from "./m365-apps.json";

const columnMetadata: ColumnMetadataMap = {
    "[App]": { name: "App", displayName: "App" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Reach]": { name: "Reach", displayName: "Share of active people", format: FORMAT_PERCENT },
};

/** Which Microsoft 365 apps the people active on Microsoft 365 opened, on any platform. */
export function m365Apps() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
