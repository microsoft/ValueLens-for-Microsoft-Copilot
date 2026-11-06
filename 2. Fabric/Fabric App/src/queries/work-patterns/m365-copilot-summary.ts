//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./m365-copilot-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[M365 People]": { name: "M365 People", displayName: "People active on Microsoft 365", format: FORMAT_WHOLE },
    "[Copilot People]": { name: "Copilot People", displayName: "Also using Copilot or agents", format: FORMAT_WHOLE },
    "[Copilot Reach]": { name: "Copilot Reach", displayName: "Copilot reach", format: FORMAT_PERCENT },
    "[Not Using]": { name: "Not Using", displayName: "Not using Copilot yet", format: FORMAT_WHOLE },
    "[Licensed People]": { name: "Licensed People", displayName: "Licensed", format: FORMAT_WHOLE },
    "[Licensed Not Using]": { name: "Licensed Not Using", displayName: "Licensed, not using", format: FORMAT_WHOLE },
    "[Licensed Idle Share]": { name: "Licensed Idle Share", displayName: "Licensed, not using", format: FORMAT_PERCENT },
};

/**
 * How much of the Microsoft 365 workforce Copilot reaches. Anyone with
 * Copilot Chat or agent activity in the selection counts as using it, and a
 * license counts as idle when its holder worked on Microsoft 365 but never
 * reached for Copilot.
 */
export function m365CopilotSummary() {
    return { connection, query, columnMetadata };
}
