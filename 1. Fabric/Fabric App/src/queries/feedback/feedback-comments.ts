//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./feedback-comments.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Date Submitted]": { name: "Date Submitted", displayName: "Date submitted", format: "dd mmm yyyy" },
    "[Feedback Type]": { name: "Feedback Type", displayName: "Feedback" },
    "[Feedback Emoji]": { name: "Feedback Emoji", displayName: "Signal" },
    "[Category]": { name: "Category", displayName: "Category" },
    "[Surface / Agent]": { name: "Surface / Agent", displayName: "Surface or agent" },
    "[Comment]": { name: "Comment", displayName: "Comment" },
};

/**
 * The most recent non-empty comments, capped before they reach the grid.
 *
 * These are raw customer comments in live use, so the app reads them directly
 * while tests use invented fixture text only.
 */
export function feedbackComments() {
    return { connection, query, columnMetadata };
}
