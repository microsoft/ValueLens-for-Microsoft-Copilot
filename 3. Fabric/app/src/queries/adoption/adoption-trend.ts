//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./adoption-trend.dax?raw";
import spec from "./adoption-trend.json";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[WeekStart]": {
        name: "Chat + Agent Interactions (Audit Logs)WeekStart",
        displayName: "Week starting",
        format: "dd mmm yyyy",
    },
    "[Licensed]": { name: "Licensed", displayName: "Licensed", format: FORMAT_RATE },
    "[Unlicensed]": { name: "Unlicensed", displayName: "Unlicensed", format: FORMAT_RATE },
    "[Agents]": { name: "Agents", displayName: "Agents", format: FORMAT_RATE },
    "[All Sessions]": { name: "All Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
};

/** Series the weekly trend can plot. */
export type AdoptionTrendMeasure = "sessionsPerUser" | "sessions" | "hours";

const seriesByMeasure: Record<AdoptionTrendMeasure, { fields: string[]; axisTitle: string; format: string }> = {
    sessionsPerUser: {
        fields: ["Licensed", "Unlicensed", "Agents"],
        axisTitle: "Sessions per user",
        format: ".2f",
    },
    sessions: { fields: ["All Sessions"], axisTitle: "Sessions", format: ",.0f" },
    hours: { fields: ["Hours"], axisTitle: "Expert-equivalent hours", format: ",.1f" },
};

interface AdoptionTrendParams {
    /**
     * Which series to plot. `sessionsPerUser` compares the three surfaces;
     * the others show a single total line. Defaults to `sessionsPerUser`.
     */
    measure?: AdoptionTrendMeasure;
}

/**
 * Weekly adoption trend. All series come from one query, so switching between
 * them is a spec change rather than another round trip.
 */
export function adoptionTrend(params?: AdoptionTrendParams) {
    const { fields, axisTitle, format } = seriesByMeasure[params?.measure ?? "sessionsPerUser"];
    const vegaLiteSpec = structuredClone(spec) as unknown as MutableSpec;

    const fold = vegaLiteSpec.transform.find((step): step is FoldStep => "fold" in step);
    if (!fold) throw new Error("adoption-trend.json must fold the series into one column.");
    fold.fold = fields;
    vegaLiteSpec.encoding.y.title = axisTitle;

    const tooltip = vegaLiteSpec.layer[1].encoding.tooltip;
    const valueTooltip = tooltip[tooltip.length - 1];
    valueTooltip.title = axisTitle;
    valueTooltip.format = format;

    // A single series has nothing to distinguish by colour, so drop the legend
    // and let the mark fall back to the theme's primary data colour.
    if (fields.length === 1) {
        delete vegaLiteSpec.encoding.color;
        tooltip.splice(1, 1);
    }

    return { connection, query, columnMetadata, vegaLiteSpec: vegaLiteSpec as unknown as VisualizationSpec };
}

/** Narrow view of the spec covering only the parts this factory rewrites. */
interface FoldStep {
    fold: string[];
    as: string[];
}

interface MutableSpec {
    transform: (FoldStep | { calculate: string; as: string })[];
    encoding: {
        y: { title: string };
        color?: unknown;
    };
    layer: [
        unknown,
        { encoding: { tooltip: { field: string; title: string; format?: string }[] } },
    ];
}
