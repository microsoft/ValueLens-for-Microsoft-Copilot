//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./surface-usage.dax?raw";
import spec from "./surface-usage.json";
import { cohortTaskField, type WorkCohort } from "./cohorts";

const columnMetadata: ColumnMetadataMap = {
    "[Lens]": { name: "Lens", displayName: "Lens" },
    "[Category]": { name: "Category", displayName: "Category" },
    "[All Tasks]": { name: "All Tasks", displayName: "Tasks", format: FORMAT_WHOLE },
    "[Licensed Tasks]": { name: "Licensed Tasks", displayName: "Licensed tasks", format: FORMAT_WHOLE },
    "[Unlicensed Tasks]": { name: "Unlicensed Tasks", displayName: "Unlicensed tasks", format: FORMAT_WHOLE },
    "[Agent Tasks]": { name: "Agent Tasks", displayName: "Agent tasks", format: FORMAT_WHOLE },
};

/** The two lenses the query stacks into one result, keyed by `Lens`. */
export type UsageLens = "surface" | "model";

const lenses: Record<UsageLens, { lens: string; title: string }> = {
    surface: { lens: "Surface", title: "App" },
    model: { lens: "Model", title: "Model" },
};

interface SurfaceUsageParams {
    /** Which lens to plot — the app surface or the answering model. */
    lens: UsageLens;
    /** Which cohort's task count to bind to the value axis. Defaults to `all`. */
    cohort?: WorkCohort;
}

/**
 * Task volume by app surface or by answering model.
 *
 * The report draws these as eight separate bar charts across two bookmarked
 * pages — one per cohort per lens. Both lenses and all four cohorts arrive in
 * one ten-row result here, so neither toggle refetches; they only rebind the
 * spec.
 */
export function surfaceUsage(params: SurfaceUsageParams) {
    const { lens, title } = lenses[params.lens];

    const vegaLiteSpec = JSON.parse(
        JSON.stringify(spec)
            .replaceAll("__LENS__", lens)
            .replaceAll("__VALUE__", cohortTaskField(params.cohort ?? "all"))
            .replaceAll("__TITLE__", title),
    ) as VisualizationSpec;

    return { connection, query, columnMetadata, vegaLiteSpec };
}
