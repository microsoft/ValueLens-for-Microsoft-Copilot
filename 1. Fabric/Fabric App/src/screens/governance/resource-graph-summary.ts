//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useSummaryQuery, type SummaryResult } from "@/hooks/use-table-query";
import { describeResourceGraph, governanceResourceGraph, type ResourceGraphView } from "@/queries/governance";

const RESOURCE_GRAPH = governanceResourceGraph();
const SKIPPED = { ...RESOURCE_GRAPH, query: "" };

export interface ResourceGraphSummary {
    result: SummaryResult;
    view: ResourceGraphView;
}

/** The Resource Graph figures, skipped when the install left the source off. */
export function useResourceGraphSummary(): ResourceGraphSummary {
    const sources = useSourceAvailability();
    const result = useSummaryQuery(sources.resourceGraph === "notConfigured" ? SKIPPED : RESOURCE_GRAPH);
    return { result, view: describeResourceGraph(result, sources.resourceGraph) };
}
