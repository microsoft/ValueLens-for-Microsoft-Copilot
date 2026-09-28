//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./habit-trend.dax?raw";
import spec from "./habit-trend.json";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[MonthStart]": {
        name: "Chat + Agent Interactions (Audit Logs)MonthStart",
        displayName: "Month",
        format: "mmm yyyy",
    },
    "Stage Legend[Stage]": { name: "Stage LegendStage", displayName: "Stage" },
    "[Users]": { name: "Users", displayName: "Users", format: FORMAT_WHOLE },
};

interface HabitTrendParams {
    /**
     * `share` normalises each month to 100% to show the mix shifting;
     * `count` keeps absolute user counts. Defaults to `share`.
     */
    scale?: "share" | "count";
}

/**
 * How the habit mix moves month over month, as a stacked area.
 *
 * Stage labels arrive numbered (`0 - Inactive` … `4 - Power`) so a descending
 * sort puts the most engaged stage on top without a lookup.
 */
export function habitTrend(params?: HabitTrendParams) {
    const vegaLiteSpec = structuredClone(spec) as unknown as MutableSpec;

    if (params?.scale === "count") {
        vegaLiteSpec.encoding.y.stack = "zero";
        vegaLiteSpec.encoding.y.title = "Users";
        vegaLiteSpec.encoding.y.axis = { labelExpr: "format(datum.value, ',.0f')" };
    }

    return { connection, query, columnMetadata, vegaLiteSpec: vegaLiteSpec as unknown as VisualizationSpec };
}

/** Narrow view of the spec covering only the parts this factory rewrites. */
interface MutableSpec {
    encoding: {
        y: { stack: string; title: string; axis: { labelExpr: string } };
    };
}
