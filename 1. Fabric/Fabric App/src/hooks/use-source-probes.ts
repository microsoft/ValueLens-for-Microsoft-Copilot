//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { readSourceState, SOURCE_PROBES, type SourceAvailability, type SourceState } from "@/lib/optional-sources";
import { toSummaryRow } from "@/lib/summary-row";
import { connection } from "@/queries/shared";
import { useSemanticModelQuery } from "./use-semantic-model-query";

function useProbe(query: string): SourceState {
    const { data, error } = useSemanticModelQuery({ connection, query });
    return useMemo(
        () =>
            readSourceState({
                row: data?.status === "success" ? toSummaryRow(data.table) : undefined,
                loaded: data?.status === "success",
                error: data?.status === "error" ? data.error.message : error?.message,
            }),
        [data, error],
    );
}

/**
 * Probes each optional source once, without the filter bar, so a filter that
 * empties the selection never takes a page away.
 */
export function useSourceProbes(): SourceAvailability {
    const m365Activity = useProbe(SOURCE_PROBES.m365Activity);
    const productFeedback = useProbe(SOURCE_PROBES.productFeedback);
    const agentRegistry = useProbe(SOURCE_PROBES.agentRegistry);
    return useMemo(
        () => ({ m365Activity, productFeedback, agentRegistry }),
        [m365Activity, productFeedback, agentRegistry],
    );
}
