//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./habit-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Power]": { name: "Power", displayName: "Power users", format: FORMAT_WHOLE },
    "[Power Pct]": { name: "Power Pct", displayName: "% power users", format: FORMAT_PERCENT },
    "[Habitual]": { name: "Habitual", displayName: "Habitual users", format: FORMAT_WHOLE },
    "[Habitual Pct]": { name: "Habitual Pct", displayName: "% habitual users", format: FORMAT_PERCENT },
    "[Developing]": { name: "Developing", displayName: "Developing users", format: FORMAT_WHOLE },
    "[Developing Pct]": { name: "Developing Pct", displayName: "% developing users", format: FORMAT_PERCENT },
    "[Beginner]": { name: "Beginner", displayName: "Beginner users", format: FORMAT_WHOLE },
    "[Beginner Pct]": { name: "Beginner Pct", displayName: "% beginner users", format: FORMAT_PERCENT },
    "[Inactive]": { name: "Inactive", displayName: "Inactive users", format: FORMAT_WHOLE },
    "[Inactive Pct]": { name: "Inactive Pct", displayName: "% inactive users", format: FORMAT_PERCENT },
};

/** Habit stages, ordered from most to least engaged. */
export const habitStages = [
    "Power",
    "Habitual",
    "Developing",
    "Beginner",
    "Inactive",
] as const;

export type HabitStage = (typeof habitStages)[number];

/** Counts and shares for all five habit stages in the most recent month. */
export function habitSummary() {
    return { connection, query, columnMetadata };
}
