//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./model-fit-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Logged Share]": { name: "Logged Share", displayName: "Logged share", format: FORMAT_PERCENT },
    "[Well-matched Share]": { name: "Well-matched Share", displayName: "Well-matched", format: FORMAT_PERCENT },
    "[Over-specified Share]": { name: "Over-specified Share", displayName: "Over-specified", format: FORMAT_PERCENT },
    "[Under-specified Share]": { name: "Under-specified Share", displayName: "Under-specified", format: FORMAT_PERCENT },
    "[Coverage Notice]": { name: "Coverage Notice", displayName: "Coverage notice" },
};

/**
 * The report's Model Fit headline, kept to the few fields that decide whether
 * model choice can be trusted in the current filter selection.
 */
export function modelFitSummary() {
    return { connection, query, columnMetadata };
}
