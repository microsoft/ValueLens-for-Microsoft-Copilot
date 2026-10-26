//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE } from "../shared";
import query from "./adoption-summary-spuw.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Overall SPUW]": { name: "Overall SPUW", displayName: "Sessions per user per week", format: FORMAT_RATE },
    "[Licensed SPUW]": { name: "Licensed SPUW", displayName: "Licensed sessions per user per week", format: FORMAT_RATE },
    "[Unlicensed SPUW]": { name: "Unlicensed SPUW", displayName: "Unlicensed sessions per user per week", format: FORMAT_RATE },
    "[Agent SPUW]": { name: "Agent SPUW", displayName: "Agent sessions per user per week", format: FORMAT_RATE },
    "[Cowork SPUW]": { name: "Cowork SPUW", displayName: "Cowork sessions per user per week", format: FORMAT_RATE },
};

/**
 * Sessions per user per week for all four surfaces and Cowork: the rest of
 * the Adoption summary, asked with `adoptionSummary` and under the same
 * filters. None of these figures reads hours, so the task times saved in the
 * app leave them alone and the query doesn't wait for them.
 *
 * The Cowork rate returns blank when the tenant has no Cowork telemetry.
 */
export function adoptionSummarySpuw() {
    return { connection, query, columnMetadata };
}
