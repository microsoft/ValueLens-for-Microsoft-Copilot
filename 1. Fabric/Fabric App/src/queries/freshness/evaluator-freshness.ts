//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { evaluatorConnection } from "../shared";
import query from "./evaluator-freshness.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Last Date]": { name: "Last Date", displayName: "Agent evaluation to" },
};

/** The last day Agent Evaluator has agent interactions for, whatever the filters say. */
export function evaluatorFreshness() {
    return { connection: evaluatorConnection, query, columnMetadata };
}