//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./product-feedback-freshness.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Last Date]": { name: "Last Date", displayName: "Product feedback to" },
};

/** The last day product feedback was given, whatever the filters say. */
export function productFeedbackFreshness() {
    return { connection, query, columnMetadata };
}