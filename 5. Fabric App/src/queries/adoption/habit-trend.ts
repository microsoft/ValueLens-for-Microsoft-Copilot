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
    /** Fills from Power down to Inactive; the spec's light-theme ramp when omitted. */
    colors?: readonly string[];
}

/**
 * How the habit mix moves month over month, as a stacked area.
 *
 * Stage labels arrive numbered (`0 - Inactive` … `4 - Power`). The spec strips
 * the number for display and stacks by it, so Inactive sits on the baseline
 * and Power on top — the same top-to-bottom order as the legend and the
 * ladder above the chart.
 */
export function habitTrend(params?: HabitTrendParams) {
    const vegaLiteSpec = structuredClone(spec) as unknown as MutableSpec;

    if (params?.scale === "count") {
        vegaLiteSpec.encoding.y.stack = "zero";
        vegaLiteSpec.encoding.y.title = "Users";
        vegaLiteSpec.encoding.y.axis = { labelExpr: "format(datum.value, ',.0f')" };
    }
    if (params?.colors?.length === vegaLiteSpec.encoding.color.scale.domain.length) {
        vegaLiteSpec.encoding.color.scale.range = [...params.colors];
    }

    return { connection, query, columnMetadata, vegaLiteSpec: vegaLiteSpec as unknown as VisualizationSpec };
}

/** Narrow view of the spec covering only the parts this factory rewrites. */
interface MutableSpec {
    encoding: {
        y: { stack: string; title: string; axis: { labelExpr: string } };
        color: { scale: { domain: string[]; range: string[] } };
    };
}
