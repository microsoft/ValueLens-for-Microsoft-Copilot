//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./value-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Expert Equivalent Hours Per Week]": {
        name: "Expert Equivalent Hours Per Week",
        displayName: "Expert-equivalent hours per week",
        format: FORMAT_HOURS,
    },
    "[AI Assisted Value]": { name: "AI Assisted Value", displayName: "AI assisted value", format: FORMAT_WHOLE },
    "[Projected Annualised Value]": {
        name: "Projected Annualised Value",
        displayName: "Annualised value",
        format: FORMAT_WHOLE,
    },
    "[AI Assisted Value Per Week]": {
        name: "AI Assisted Value Per Week",
        displayName: "Value per week",
        format: FORMAT_WHOLE,
    },
    "[Currency Symbol]": { name: "Currency Symbol", displayName: "Currency symbol" },
};

/**
 * The four figures that replace the report's Estimated Value card stack.
 *
 * The report leaves the value measures BLANK until the what-if parameters are
 * in context. The stage applies those parameter filters outside the query, so
 * this module only reads the measures the model already owns.
 */
export function valueSummary() {
    return { connection, query, columnMetadata };
}
