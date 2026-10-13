//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection } from "../shared";
import query from "./consumption-freshness.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Cowork Last Date]": { name: "Cowork Last Date", displayName: "Cowork to" },
    "[Studio Last Date]": { name: "Studio Last Date", displayName: "Copilot Studio to" },
    "[Azure Last Date]": { name: "Azure Last Date", displayName: "Azure to" },
};

/**
 * The last date Cowork credits, Copilot Studio credits and Azure spend each
 * have rows for, in one round-trip, whatever the filters say. Cowork's is the
 * start of the last week loaded.
 */
export function consumptionFreshness() {
    return { connection: consumptionConnection, query, columnMetadata };
}