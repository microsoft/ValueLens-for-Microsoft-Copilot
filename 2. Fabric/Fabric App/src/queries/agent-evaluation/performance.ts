//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { humanizeIdentifier, relabelColumn, withoutEmoji } from "@/lib/model-text";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { evaluatorConnection as connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import type { GroupByColumn } from "./options";
import byGroupQuery from "./performance-by-group.dax?raw";
import errorsQuery from "./performance-errors.dax?raw";
import errorsSpec from "./performance-errors.json";
import summaryQuery from "./performance-summary.dax?raw";
import weeklyQuery from "./performance-weekly.dax?raw";
import weeklySpec from "./performance-weekly.json";

/** Seconds, to one decimal place. */
const FORMAT_SECONDS = "0.0";

const summaryColumns: ColumnMetadataMap = {
    "[Conversations]": { name: "Conversations", displayName: "Conversations", format: FORMAT_WHOLE },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Conversations Per Person]": { name: "Conversations Per Person", displayName: "Conversations per person", format: FORMAT_RATE },
    "[Resolution Rate]": { name: "Resolution Rate", displayName: "Resolved", format: FORMAT_PERCENT },
    "[Implied Success]": { name: "Implied Success", displayName: "Implied success", format: FORMAT_PERCENT },
    "[True Failure Rate]": { name: "True Failure Rate", displayName: "Failed", format: FORMAT_PERCENT },
    "[Failing Conversations]": { name: "Failing Conversations", displayName: "Failing conversations", format: FORMAT_WHOLE },
    "[Hours Lost]": { name: "Hours Lost", displayName: "Hours lost", format: FORMAT_HOURS },
    "[Unintended Escalation Rate]": { name: "Unintended Escalation Rate", displayName: "Escalated after an error", format: FORMAT_PERCENT },
    "[Intended Share]": { name: "Intended Share", displayName: "Escalations by design", format: FORMAT_PERCENT },
    "[Abandonment Rate]": { name: "Abandonment Rate", displayName: "Abandoned", format: FORMAT_PERCENT },
    "[CSAT]": { name: "CSAT", displayName: "Satisfaction", format: FORMAT_PERCENT },
    "[Thumbs Up]": { name: "Thumbs Up", displayName: "Thumbs up", format: FORMAT_WHOLE },
    "[Thumbs Down]": { name: "Thumbs Down", displayName: "Thumbs down", format: FORMAT_WHOLE },
    "[Error Rate]": { name: "Error Rate", displayName: "Hit an error", format: FORMAT_PERCENT },
    "[Median Response]": { name: "Median Response", displayName: "Median reply", format: FORMAT_SECONDS },
    "[Slow Replies]": { name: "Slow Replies", displayName: "Replies over 10s", format: FORMAT_PERCENT },
    "[Reporting Window]": { name: "Reporting Window", displayName: "Reporting window" },
    "[Verdict Performance]": { name: "Verdict Performance", displayName: "Performance" },
    "[Verdict Quality]": { name: "Verdict Quality", displayName: "Quality" },
    "[Verdict Adoption]": { name: "Verdict Adoption", displayName: "Adoption" },
    "[Focus Agent]": { name: "Focus Agent", displayName: "Weakest agent" },
    "[Focus Knowledge]": { name: "Focus Knowledge", displayName: "Knowledge gap" },
    "[Focus Give Up]": { name: "Focus Give Up", displayName: "Where people give up" },
    "[Escalation Verdict]": { name: "Escalation Verdict", displayName: "Escalations" },
    "[Error Story]": { name: "Error Story", displayName: "Errors" },
    "[Response Read]": { name: "Response Read", displayName: "Reply speed" },
};

/**
 * The report's At a Glance page as one row: how many conversations, how they
 * ended, what people thought, and the model's own verdicts on them. Its
 * column names match the by-group query, so it doubles as that table's total.
 */
export function performanceSummary() {
    return { connection, query: summaryQuery, columnMetadata: summaryColumns };
}

const weeklyColumns: ColumnMetadataMap = {
    "[Week Start]": { name: "Week Start", displayName: "Week starting", format: "dd mmm yyyy" },
    "[Outcome]": { name: "Outcome", displayName: "Ended" },
    "[Outcome Order]": { name: "Outcome Order", displayName: "Order", format: FORMAT_WHOLE },
    "[Conversations]": { name: "Conversations", displayName: "Conversations", format: FORMAT_WHOLE },
};

/** How conversations ended, week by week, so a drift in either volume or outcome shows. */
export function performanceWeekly() {
    return { connection, query: weeklyQuery, columnMetadata: weeklyColumns, vegaLiteSpec: weeklySpec as VisualizationSpec };
}

/** The outcomes as the weekly and theme charts name them, best first. */
export const OUTCOMES = ["Resolved", "Escalated by design", "Escalated after an error", "Abandoned"] as const;

const byGroupColumns: ColumnMetadataMap = {
    "[Group]": { name: "Group", displayName: "Group" },
    "[Conversations]": summaryColumns["[Conversations]"],
    "[People]": summaryColumns["[People]"],
    "[Resolution Rate]": summaryColumns["[Resolution Rate]"],
    "[True Failure Rate]": summaryColumns["[True Failure Rate]"],
    "[Unintended Escalation Rate]": summaryColumns["[Unintended Escalation Rate]"],
    "[Abandonment Rate]": summaryColumns["[Abandonment Rate]"],
    "[CSAT]": summaryColumns["[CSAT]"],
    "[Error Rate]": summaryColumns["[Error Rate]"],
    "[Median Response]": summaryColumns["[Median Response]"],
};

/** Every headline rate for each group of a Group by column, largest group first. */
export function performanceByGroup(group: GroupByColumn) {
    return { connection, query: byGroupQuery.replaceAll("__GROUP__", group.column), columnMetadata: byGroupColumns };
}

/** Group names as people read them: blanks named, and topic identifiers as words. */
export function readableGroups(table: DataTable, group: GroupByColumn): DataTable {
    const index = table.columns.findIndex((column) => column.name === "Group");
    if (index < 0) return table;
    return {
        columns: table.columns,
        rows: table.rows.map((row) => {
            const value = typeof row[index] === "string" ? (row[index] as string).trim() : "";
            const label = value === "" ? "(Not recorded)" : group.humanize ? humanizeIdentifier(value) : value;
            if (label === row[index]) return row;
            const next = [...row];
            next[index] = label;
            return next;
        }),
    };
}

const errorsColumns: ColumnMetadataMap = {
    "[Error Code]": { name: "Error Code", displayName: "Error" },
    "[Source]": { name: "Source", displayName: "Cause" },
    "[Errors]": { name: "Errors", displayName: "Errors", format: FORMAT_WHOLE },
};

/** The ten error codes behind the most errors, and whether the agent or the user hit them. */
export function performanceErrors() {
    return { connection, query: errorsQuery, columnMetadata: errorsColumns, vegaLiteSpec: errorsSpec as VisualizationSpec };
}

/** Error codes as words, and the cause without the model's emoji. */
export function readableErrors(table: DataTable): DataTable {
    return relabelColumn(relabelColumn(table, "Error Code", humanizeIdentifier), "Source", withoutEmoji);
}
