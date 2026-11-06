//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./cowork-readiness-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Eligible Users]": { name: "Eligible Users", displayName: "Eligible users", format: FORMAT_WHOLE },
    "[Surfaces Per Day]": {
        name: "Surfaces Per Day",
        displayName: "Apps per active day",
        format: FORMAT_RATE,
    },
    "[Prompts Per Session]": {
        name: "Prompts Per Session",
        displayName: "Prompts per session",
        format: FORMAT_RATE,
    },
    "[Agent User Share]": {
        name: "Agent User Share",
        displayName: "% already using agents",
        format: FORMAT_PERCENT,
    },
};

/**
 * The three signals the readiness score weighs, measured across everyone who
 * uses Copilot but has not yet tried Cowork.
 */
export function coworkReadinessSummary() {
    return { connection, query, columnMetadata };
}
