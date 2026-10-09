//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./habit-licence-matrix.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Month]": { name: "Month", displayName: "Month", format: "mmmm yyyy" },
    "[Cohort]": { name: "Cohort", displayName: "Habit" },
    "[Cohort Order]": { name: "Cohort Order", displayName: "Order", format: FORMAT_WHOLE },
    "[Licensed]": { name: "Licensed", displayName: "Licensed", format: FORMAT_WHOLE },
    "[Unlicensed]": { name: "Unlicensed", displayName: "Unlicensed", format: FORMAT_WHOLE },
};

/**
 * Active people in the last full month, by habit and licence: one row per
 * habit (Power, Habitual, Developing, Beginner) with how many were licensed
 * and how many weren't. The habits count distinct active days, as the
 * Adoption page does.
 */
export function habitLicenceMatrix() {
    return { connection, query, columnMetadata };
}
