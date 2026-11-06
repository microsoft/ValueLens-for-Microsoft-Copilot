//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./m365-platforms.dax?raw";
import spec from "./m365-platforms.json";

const columnMetadata: ColumnMetadataMap = {
    "[Platform]": { name: "Platform", displayName: "Platform" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Reach]": { name: "Reach", displayName: "Share of active people", format: FORMAT_PERCENT },
    "[Days Per Week]": { name: "Days Per Week", displayName: "Days per week, when used", format: FORMAT_RATE },
};

/**
 * Where people open the Microsoft 365 apps from. Someone on a laptop and a
 * phone counts on both, so the shares add up to more than the whole.
 */
export function m365Platforms() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
