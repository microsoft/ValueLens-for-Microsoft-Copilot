//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./governance-exposure.dax?raw";
import spec from "./governance-exposure.json";

const columnMetadata: ColumnMetadataMap = {
    "[Scope Order]": { name: "Scope Order", displayName: "Scope order" },
    "[Sharing Scope]": { name: "Sharing Scope", displayName: "Shared with" },
    "[Access Order]": { name: "Access Order", displayName: "Access order" },
    "[Data Access]": { name: "Data Access", displayName: "Can read" },
    "[Agents]": { name: "Agents", displayName: "Agents", format: FORMAT_WHOLE },
    "[Unused Agents]": { name: "Unused Agents", displayName: "No recorded use", format: FORMAT_WHOLE },
};

/**
 * How widely each tenant-built agent is shared against what it can read:
 * the cell where whole-organisation sharing meets organisation content is
 * the one worth a look. Blocked agents are left out, since nobody can reach
 * them. The order columns keep both axes in risk order, widest first.
 */
export function governanceExposure() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}

export interface ExposureThemeColors {
    /** The empty end of the ramp, usually the hover surface. */
    quiet: string;
    /** The full end of the ramp, the destination's brand hue. */
    strong: string;
    quietText: string;
    strongText: string;
}

/**
 * Colours the heatmap from the destination palette once the theme has been
 * read, as the adoption trend heatmap does, so the JSON carries no colours.
 */
export function applyExposureTheme(baseSpec: VisualizationSpec, colors: ExposureThemeColors): VisualizationSpec {
    const themed = structuredClone(baseSpec) as unknown as MutableHeatmapSpec;
    themed.layer[0].encoding.color.scale = {
        ...(themed.layer[0].encoding.color.scale ?? {}),
        range: [colors.quiet, colors.strong],
    };
    themed.layer[1].encoding.color = {
        condition: { test: "datum['Heat'] > 0.58", value: colors.strongText },
        value: colors.quietText,
    };
    return themed as unknown as VisualizationSpec;
}

interface MutableHeatmapSpec {
    layer: [{ encoding: { color: { scale?: Record<string, unknown> } } }, { encoding: { color?: unknown } }];
}
