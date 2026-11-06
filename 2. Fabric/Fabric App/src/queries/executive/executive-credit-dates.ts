//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection } from "../shared";
import query from "./executive-credit-dates.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Last Date]": { name: "Last Date", displayName: "Credits through" },
};

/**
 * The last day Consumption Central has credits for, so the page can say how
 * fresh they are. Its date table runs on past the data, so the table's own
 * last date can't say that.
 */
export function executiveCreditDates() {
    return { connection: consumptionConnection, query, columnMetadata };
}
