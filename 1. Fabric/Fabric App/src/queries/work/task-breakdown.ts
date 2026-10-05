//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./task-breakdown.dax?raw";
import spec from "./task-breakdown.json";

const columnMetadata: ColumnMetadataMap = {
    "[Dimension]": { name: "Dimension", displayName: "Lens" },
    "[Category]": { name: "Category", displayName: "Category" },
    "[Tasks]": { name: "Tasks", displayName: "Tasks", format: FORMAT_WHOLE },
    "[Share]": { name: "Share", displayName: "Share of all tasks", format: FORMAT_PERCENT },
};

/** The three lenses the query stacks into one result, keyed by `Dimension`. */
export type TaskDimension = "behaviour" | "action" | "outcome";

const lenses: Record<TaskDimension, { dimension: string; label: string; title: string; subtitle: string }> = {
    behaviour: {
        // The query's own name for this lens; people see the label.
        dimension: "Behaviour",
        label: "Task Breakdown",
        title: "Tasks by Task Breakdown",
        subtitle: "The detailed task each request was read as",
    },
    action: {
        dimension: "Workflow action",
        label: "Workflow action",
        title: "Tasks by workflow action",
        subtitle: "What Copilot was asked to do with the content",
    },
    outcome: {
        dimension: "Value outcome",
        label: "Value outcome",
        title: "Tasks by value outcome",
        subtitle: "The benefit the task was classified as delivering",
    },
};

/** The lenses in the order the toggle presents them. */
export const taskDimensions = (Object.keys(lenses) as TaskDimension[]).map((id) => ({
    id,
    label: lenses[id].label,
}));

interface TaskBreakdownParams {
    /** Which lens to plot. Defaults to `behaviour`. */
    dimension?: TaskDimension;
}

/**
 * Task volume by category, drawn as a sorted horizontal bar.
 *
 * The report gives each lens its own treemap on its own bookmark. Unioning all
 * three into one 27-row result means switching lens filters rows already in
 * the browser rather than refetching.
 *
 * `Share` is each category's slice of *all* recorded activity, so the shares
 * within any one lens sum to 100% and the three lenses stay comparable.
 */
export function taskBreakdown(params?: TaskBreakdownParams) {
    const lens = lenses[params?.dimension ?? "behaviour"];

    const vegaLiteSpec = JSON.parse(
        JSON.stringify(spec).replaceAll("__DIMENSION__", lens.dimension).replaceAll("__TITLE__", lens.label),
    ) as VisualizationSpec;

    return { connection, query, columnMetadata, vegaLiteSpec, ...lens };
}
