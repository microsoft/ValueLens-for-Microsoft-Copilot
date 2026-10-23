//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./license-estate-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Total Licensed Users]": {
        name: "Total Licensed Users",
        displayName: "Total licensed users",
        format: FORMAT_WHOLE,
    },
    "[Avg Days Since Last Active]": {
        name: "Avg Days Since Last Active",
        displayName: "Avg days since last active",
        format: FORMAT_HOURS,
    },
    "[License Evidence Notice]": {
        name: "License Evidence Notice",
        displayName: "License evidence notice",
    },
    "[Reclaim Cost Notice]": { name: "Reclaim Cost Notice", displayName: "Reclaim cost notice" },
    // 1 when the license roster joins to the people using Copilot; 0 when it doesn't
    // (no roster, or user names hidden in the Microsoft 365 reports).
    "[License Inventory Usable]": { name: "License Inventory Usable", displayName: "License inventory usable" },
};

/**
 * License roster totals and the model's evidence notes.
 *
 * The roster has no date grain and no independent organization dimension, so
 * the stage deliberately lets these figures describe the whole license estate.
 */
export function licenseEstateSummary() {
    return { connection, query, columnMetadata };
}
