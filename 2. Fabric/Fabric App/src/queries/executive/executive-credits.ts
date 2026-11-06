//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection, FORMAT_CREDITS } from "../shared";
import query from "./executive-credits.dax?raw";
import spec from "./executive-credits.json";
import { shapeMonthlyTrend, type MonthlyTrendParams } from "./monthly-trend";

const columnMetadata: ColumnMetadataMap = {
    "[Month Start]": { name: "Month Start", displayName: "Month", format: "mmm yyyy" },
    "[Studio Credits]": { name: "Studio Credits", displayName: "Copilot Studio agents", format: FORMAT_CREDITS },
    "[Cowork Credits]": { name: "Cowork Credits", displayName: "Cowork", format: FORMAT_CREDITS },
};

/**
 * Copilot Studio and Cowork credits by month from Consumption Central. They
 * cover the whole tenant: the model has no department to narrow them by.
 * The caller limits 'Reporting Date' to the months the hours trend shows.
 */
export function executiveCredits(params?: MonthlyTrendParams) {
    return {
        connection: consumptionConnection,
        query,
        columnMetadata,
        vegaLiteSpec: shapeMonthlyTrend(spec, params),
    };
}
