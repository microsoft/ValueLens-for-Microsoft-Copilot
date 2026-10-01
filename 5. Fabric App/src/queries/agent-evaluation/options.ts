//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { dateBetween, treatAs } from "@/lib/dax-filters";
import { availablePresets, presetRange, type DatePreset, type DateRange } from "@/lib/filters";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { evaluatorConnection as connection, FORMAT_WHOLE } from "../shared";
import query from "./evaluation-options.dax?raw";

export interface GroupByColumn {
    id: string;
    label: string;
    /** A fully qualified column reference, substituted into the by-group query. */
    column: string;
    /** Topic names are written as identifiers ("PolicyLookup") and read better as words. */
    humanize?: boolean;
}

/**
 * The columns the Performance table can be grouped by. A fixed list rather
 * than the report's Group By field parameter, which a query can't drive, and
 * the only columns ever substituted into a query.
 */
export const GROUP_BY_COLUMNS: readonly GroupByColumn[] = [
    { id: "agent", label: "Agent", column: "'Agent Performance'[BotFriendlyName]" },
    { id: "department", label: "Department", column: "'Chat + Agent Org Data'[Organization]" },
    { id: "theme", label: "Topic theme", column: "'Agent Performance'[Topic Theme]" },
    { id: "topic", label: "Topic", column: "'Agent Performance'[Topic (resolved)]", humanize: true },
    { id: "job-title", label: "Job title", column: "'Chat + Agent Org Data'[JobTitle]" },
    { id: "office", label: "Office", column: "'Chat + Agent Org Data'[officeLocation]" },
    { id: "country", label: "Country", column: "'Chat + Agent Org Data'[country]" },
    { id: "usage-location", label: "Usage location", column: "'Chat + Agent Org Data'[usageLocation]" },
    { id: "company", label: "Company", column: "'Chat + Agent Org Data'[companyName]" },
    { id: "function", label: "Function", column: "'Chat + Agent Org Data'[Function]" },
    { id: "location", label: "Location", column: "'Chat + Agent Org Data'[Location]" },
];

/** How many groups a column would show, counting only groups with conversations. */
function groupCount({ id, column }: GroupByColumn): string {
    return `ROW("Kind", "Group by", "Value", "${id}", "Sort", COUNTROWS(FILTER(SUMMARIZECOLUMNS(${column}, "@Conversations", [Total Conversations]), ${column} <> "")))`;
}

const columnMetadata: ColumnMetadataMap = {
    "[Kind]": { name: "Kind", displayName: "Kind" },
    "[Value]": { name: "Value", displayName: "Value" },
    "[Sort]": { name: "Sort", displayName: "Conversations", format: FORMAT_WHOLE },
};

/** The page's slicer choices and data window, read once and never filtered by the page itself. */
export function evaluationOptions() {
    return {
        connection,
        query: query.replace("__GROUP_COUNTS__", GROUP_BY_COLUMNS.map(groupCount).join(",\n    ")),
        columnMetadata,
    };
}

export interface EvaluationChoice {
    value: string;
    label: string;
    count: number;
}

export interface EvaluationOptions {
    firstDate: string | undefined;
    lastDate: string | undefined;
    departments: EvaluationChoice[];
    agents: EvaluationChoice[];
    /** Groups each Group by column would show, by column id. */
    groupCounts: Record<string, number>;
}

/** Sorts the options query into the page's slicers, largest first as the query orders them. */
export function readEvaluationOptions(table: DataTable): EvaluationOptions {
    const options: EvaluationOptions = { firstDate: undefined, lastDate: undefined, departments: [], agents: [], groupCounts: {} };
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [kind, value, sort] = ["Kind", "Value", "Sort"].map(at);
    for (const row of table.rows) {
        const text = typeof row[value] === "string" ? (row[value] as string).trim() : "";
        const count = typeof row[sort] === "number" ? (row[sort] as number) : 0;
        if (!text) continue;
        switch (row[kind]) {
            case "First date":
                options.firstDate = text;
                break;
            case "Last date":
                options.lastDate = text;
                break;
            case "Department":
                options.departments.push({ value: text, label: text, count });
                break;
            case "Agent":
                options.agents.push({ value: text, label: text, count });
                break;
            case "Group by":
                options.groupCounts[text] = count;
                break;
        }
    }
    return options;
}

/** Group by columns worth offering: one group would only repeat the total. */
export function groupByChoices(groupCounts: Record<string, number>): GroupByColumn[] {
    return GROUP_BY_COLUMNS.filter((column) => (groupCounts[column.id] ?? 0) >= 2);
}

export type EvaluationPreset = Exclude<DatePreset, "custom">;

export interface EvaluationSelection {
    preset: EvaluationPreset;
    department: string | undefined;
    agent: string | undefined;
}

export const NO_SELECTION: EvaluationSelection = { preset: "all", department: undefined, agent: undefined };

/** The dates a preset covers in this model, or nothing for all of them. */
export function selectionRange(
    preset: EvaluationPreset,
    options: Pick<EvaluationOptions, "firstDate" | "lastDate"> | undefined,
): DateRange | undefined {
    const first = options?.firstDate;
    const last = options?.lastDate;
    if (preset === "all" || !first || !last) return undefined;
    return availablePresets(first, last).includes(preset) ? presetRange(preset, first, last) : undefined;
}

/** The DAX filters for the page's slicers, applied to every query on it. */
export function evaluationFilters(selection: EvaluationSelection, options: EvaluationOptions | undefined): string[] {
    const filters: string[] = [];
    const range = selectionRange(selection.preset, options);
    if (range) filters.push(dateBetween("'Calendar'[Date]", range.from, range.to));
    if (selection.department) filters.push(treatAs("'Chat + Agent Org Data'[Organization]", [selection.department]));
    if (selection.agent) filters.push(treatAs("'Agent Performance'[BotFriendlyName]", [selection.agent]));
    return filters;
}
