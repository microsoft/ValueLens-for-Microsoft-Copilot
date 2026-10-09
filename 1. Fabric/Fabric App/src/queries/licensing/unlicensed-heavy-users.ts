//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./unlicensed-heavy-users.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[User]": { name: "User", displayName: "User" },
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[Active Days]": { name: "Active Days", displayName: "Active days", format: FORMAT_WHOLE },
    "[Cohort]": { name: "Cohort", displayName: "Habit" },
};

/**
 * The ten unlicensed people with the most active days in the last full
 * month, among those active on 11 or more days (Power and Habitual).
 */
export function unlicensedHeavyUsers() {
    return { connection, query, columnMetadata };
}
