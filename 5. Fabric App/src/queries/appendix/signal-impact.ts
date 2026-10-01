//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./signal-impact.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Signal]": { name: "Signal", displayName: "Signal" },
    "[AI Tasks]": { name: "AI Tasks", displayName: "AI task" },
    "[Use Case]": { name: "Use Case", displayName: "Use case" },
    "[Value Outcome]": { name: "Value Outcome", displayName: "Value outcome" },
    "[Human Equivalent (Minutes)]": {
        name: "Human Equivalent (Minutes)",
        displayName: "Human minutes",
        format: "0",
    },
    "[Research Source]": { name: "Research Source", displayName: "Research source" },
    "[Source URL]": { name: "Source URL", displayName: "Source URL" },
    "[Confidence]": { name: "Confidence", displayName: "Confidence" },
    "[Category]": { name: "Category", displayName: "Category" },
};

/**
 * The report's Signal → Impact appendix: each audit-log signal, the AI task it
 * is read as, and the human-time estimate and research behind its value.
 *
 * `Behavior Value Map` holds the signals and `Human Time Estimates` the
 * editable minutes; they are joined on Behavior with LOOKUPVALUE so the query
 * does not depend on which way the model's relationship filters.
 */
export function signalImpact() {
    return { connection, query, columnMetadata };
}
