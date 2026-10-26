//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./executive-departments.dax?raw";
import mapSpec from "./executive-department-map.json";

export const DEPARTMENT_COLUMN = "Chat + Agent Org DataOrganization";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": { name: DEPARTMENT_COLUMN, displayName: "Organization" },
    "[Licensed Seats]": { name: "Licensed Seats", displayName: "Licensed seats", format: FORMAT_WHOLE },
    "[Seats In Use Pct]": { name: "Seats In Use Pct", displayName: "Seats in use", format: FORMAT_PERCENT },
    "[Habit Pct]": { name: "Habit Pct", displayName: "Habit rate", format: FORMAT_PERCENT },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[People]": { name: "People", displayName: "People with a task", format: FORMAT_WHOLE },
    "[Hours Per Seat Month]": { name: "Hours Per Seat Month", displayName: "Hours per seat a month", format: FORMAT_HOURS },
};

/**
 * Where Copilot is landing: each organization's seats, habit and
 * expert-equivalent hours, ranked by hours per licensed seat a month so
 * departments of different sizes compare fairly.
 *
 * Authored against `Organization`; bind it to the chosen org column with
 * `withOrgAttribute`.
 */
export function executiveDepartments() {
    return { connection, query, columnMetadata };
}

/** The fewest groups worth plotting against each other; below this the grid says it all. */
export const DEPARTMENT_MAP_MIN = 3;

/**
 * The same rows as a map: how widely each group uses its seats against how
 * much each seat delivers, sized by seats, with dashed lines at the median
 * group so the quadrants read without a key. The largest six are labelled.
 */
export function departmentMapSpec(orgLabel: string): VisualizationSpec {
    const built = structuredClone(mapSpec) as { layer: { encoding: { tooltip?: { title: string }[] } }[] };
    for (const layer of built.layer) {
        const name = layer.encoding.tooltip?.[0];
        if (name) name.title = orgLabel;
    }
    return built as unknown as VisualizationSpec;
}
