//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./glossary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Page]": { name: "Page", displayName: "Page" },
    "[Metric]": { name: "Metric", displayName: "Metric" },
    "[Description]": { name: "Description", displayName: "Description" },
    "[Page Order]": { name: "Page Order", displayName: "Page order", format: "0" },
    "[Metric Order]": { name: "Metric Order", displayName: "Metric order", format: "0" },
    "[Page Description]": { name: "Page Description", displayName: "Page description" },
};

/**
 * The report's metric glossary, one row per metric, in the order the report's
 * pages and cards present them. It is reference data, not activity, so no
 * filter applies to it.
 */
export function glossary() {
    return { connection, query, columnMetadata };
}
