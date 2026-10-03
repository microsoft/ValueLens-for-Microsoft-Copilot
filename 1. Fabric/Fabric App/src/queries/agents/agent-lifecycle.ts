//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VegaVisualCapabilities, VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./agent-lifecycle.dax?raw";
import spec from "./agent-lifecycle.json";

const columnMetadata: ColumnMetadataMap = {
    "[Lifecycle Order]": { name: "Lifecycle Order", displayName: "Lifecycle order" },
    "[Lifecycle]": { name: "Lifecycle", displayName: "Lifecycle" },
    "[Type]": { name: "Type", displayName: "Agent type" },
    "[Agents]": { name: "Agents", displayName: "Agents", format: FORMAT_WHOLE },
};

// Segment sizes span two orders of magnitude, so centred segment labels collide
// on the thin ones; the tooltip carries each count. All seven agent types must
// stay in the legend for the colours to be readable.
const capabilities: VegaVisualCapabilities = {
    disableStackedDataLabels: true,
    disableLegendTruncation: true,
};

/**
 * Every registered agent placed on the lifecycle the model derives — blocked,
 * deployed but unused, built but never deployed, and so on — split by who
 * made it.
 *
 * The report shows this as a two-column pivot. As a stacked bar, the
 * catalogue listings that dominate most registries stop drowning out the
 * handful of blocked or ownerless agents an administrator actually has to act
 * on. The model's own `Lifecycle Order` keeps the stages in sequence.
 */
export function agentLifecycle() {
    return { connection, query, columnMetadata, capabilities, vegaLiteSpec: spec as VisualizationSpec };
}
