//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./top-outcome.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Top Value Outcome]": { name: "Top Value Outcome", displayName: "Most common benefit" },
};

/**
 * The benefit behind the most expert-equivalent hours. It sits apart from
 * `workSummary` because it follows License and Activity, which the summary's
 * side-by-side cohort cards leave out, so it names the selected group's benefit.
 */
export function topOutcome() {
    return { connection, query, columnMetadata };
}
