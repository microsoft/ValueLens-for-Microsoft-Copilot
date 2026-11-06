//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./adoption-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Overall Users]": { name: "Overall Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Overall Sessions]": { name: "Overall Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Overall SPUW]": { name: "Overall SPUW", displayName: "Sessions per user per week", format: FORMAT_RATE },
    "[Overall Hours Wk]": { name: "Overall Hours Wk", displayName: "Expert-equivalent hours per week", format: FORMAT_HOURS },
    "[Overall Top Outcome]": { name: "Overall Top Outcome", displayName: "Top value outcome" },
    "[Licensed Users]": { name: "Licensed Users", displayName: "Active licensed users", format: FORMAT_WHOLE },
    "[Licensed SPUW]": { name: "Licensed SPUW", displayName: "Licensed sessions per user per week", format: FORMAT_RATE },
    "[Unlicensed Users]": { name: "Unlicensed Users", displayName: "Active unlicensed users", format: FORMAT_WHOLE },
    "[Unlicensed SPUW]": { name: "Unlicensed SPUW", displayName: "Unlicensed sessions per user per week", format: FORMAT_RATE },
    "[Agent Users]": { name: "Agent Users", displayName: "Agent users", format: FORMAT_WHOLE },
    "[Agent SPUW]": { name: "Agent SPUW", displayName: "Agent sessions per user per week", format: FORMAT_RATE },
    "[Agent Return Rate]": {
        name: "Agent Return Rate",
        displayName: "Agent return rate",
        format: FORMAT_PERCENT,
    },
    "[Cowork Users]": { name: "Cowork Users", displayName: "Cowork users", format: FORMAT_WHOLE },
    "[Cowork SPUW]": { name: "Cowork SPUW", displayName: "Cowork sessions per user per week", format: FORMAT_RATE },
    "[Cowork Hours Wk]": { name: "Cowork Hours Wk", displayName: "Cowork hours per week", format: FORMAT_HOURS },
    "[Cowork Top Outcome]": { name: "Cowork Top Outcome", displayName: "Top cowork outcome" },
};

/**
 * Depth-of-use figures for all four surfaces — overall, licensed chat,
 * unlicensed chat, agents and Cowork — in one round trip.
 *
 * Cowork columns return blank when the tenant has no Cowork telemetry, which
 * callers should surface as an empty state rather than a zero.
 */
export function adoptionSummary() {
    return { connection, query, columnMetadata };
}
