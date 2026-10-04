//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./m365-suite-depth.dax?raw";
import spec from "./m365-suite-depth.json";

const columnMetadata: ColumnMetadataMap = {
    "[Apps Used]": { name: "Apps Used", displayName: "Apps used" },
    "[Apps]": { name: "Apps", displayName: "Apps", format: FORMAT_WHOLE },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Share]": { name: "Share", displayName: "Share of active people", format: FORMAT_PERCENT },
};

/**
 * How many of the six Microsoft 365 apps each active person opened, on any
 * platform. Every depth is returned, empty ones included, so a missing bar
 * reads as nobody rather than as missing data. Zero apps is labelled as not
 * reported: those people were active on email, SharePoint or OneDrive, but the
 * app report had nothing for them.
 */
export function m365SuiteDepth() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
