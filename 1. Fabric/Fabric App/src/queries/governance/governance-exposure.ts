//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { contrastingTextColor } from "@/lib/color-scale";
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

/** Every data access column, in risk order, so the grid keeps its shape whatever the filters leave. */
export const EXPOSURE_ACCESS = ["Organisation content", "Uploaded files only", "None declared", "Not reported"] as const;

/** The sharing scopes always shown as rows; a "Not stated" row joins them only when the registry has one. */
export const EXPOSURE_SCOPES = ["Whole organisation", "Specific people or groups", "Not shared"] as const;

/**
 * The query only returns pairings that hold agents. This fills the rest of
 * the grid with empty cells, so every column and scope is always on show
 * and a missing column never reads as a chart fault. `columns` lists the
 * data access columns to always show, in risk order.
 */
export function completeExposureGrid(table: DataTable, columns: readonly string[] = EXPOSURE_ACCESS): DataTable {
    if (table.rows.length === 0) return table;
    const column = (name: string) => table.columns.findIndex((def) => def.name === name);
    const at = {
        scopeOrder: column("Scope Order"),
        scope: column("Sharing Scope"),
        accessOrder: column("Access Order"),
        access: column("Data Access"),
        agents: column("Agents"),
        unused: column("Unused Agents"),
    };
    if (Object.values(at).some((index) => index < 0)) return table;

    const scopes = new Map<string, unknown>(EXPOSURE_SCOPES.map((scope, index) => [scope, index + 1]));
    const access = new Map<string, unknown>(columns.map((level, index) => [level, index + 1]));
    const present = new Set<string>();
    for (const row of table.rows) {
        scopes.set(String(row[at.scope]), row[at.scopeOrder]);
        access.set(String(row[at.access]), row[at.accessOrder]);
        present.add(`${row[at.scope]}|${row[at.access]}`);
    }

    const filled: unknown[][] = [];
    for (const [scope, scopeOrder] of scopes) {
        for (const [level, accessOrder] of access) {
            if (present.has(`${scope}|${level}`)) continue;
            const row: unknown[] = new Array(table.columns.length).fill(null);
            row[at.scopeOrder] = scopeOrder;
            row[at.scope] = scope;
            row[at.accessOrder] = accessOrder;
            row[at.access] = level;
            row[at.agents] = 0;
            row[at.unused] = 0;
            filled.push(row);
        }
    }
    return { ...table, rows: [...table.rows, ...filled] };
}

/**
 * The one data access column that holds every agent, or undefined when
 * agents sit in more than one. A single full column is usually a gap in what
 * the registry reports rather than a finding, so the page says so.
 */
export function soleExposureAccess(table: DataTable | undefined): string | undefined {
    if (!table) return undefined;
    const access = table.columns.findIndex((def) => def.name === "Data Access");
    const agents = table.columns.findIndex((def) => def.name === "Agents");
    if (access < 0 || agents < 0) return undefined;
    const held = new Set(table.rows.filter((row) => Number(row[agents]) > 0).map((row) => String(row[access])));
    return held.size === 1 ? [...held][0] : undefined;
}

export interface ExposureThemeColors {
    /** The empty end of the ramp, usually the hover surface. */
    quiet: string;
    /** The full end of the ramp, the destination's brand hue. */
    strong: string;
    /** One label colour, usually the page text. */
    quietText: string;
    /** The other label colour, usually the page background. Each cell takes whichever reads better on it. */
    strongText: string;
}

/**
 * Colours the heatmap from the destination palette once the theme has been
 * read, as the adoption trend heatmap does, so the JSON carries no colours.
 */
export function applyExposureTheme(baseSpec: VisualizationSpec, colors: ExposureThemeColors): VisualizationSpec {
    const themed = structuredClone(baseSpec) as unknown as MutableHeatmapSpec;
    const cellColor = themed.layer[0].encoding.color;
    cellColor.scale = { ...(cellColor.scale ?? {}), range: [colors.quiet, colors.strong] };
    themed.layer[1].encoding.color = contrastingTextColor(cellColor.field, colors.quietText, colors.strongText);
    return themed as unknown as VisualizationSpec;
}

interface MutableHeatmapSpec {
    layer: [{ encoding: { color: { field: string; scale?: Record<string, unknown> } } }, { encoding: { color?: unknown } }];
}