//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import type { CachedQueryResult } from "@microsoft/fabric-app-data";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import type { SummaryResult } from "@/hooks/use-table-query";
import type { FilterKey } from "@/lib/filters";
import { toSummaryRow } from "@/lib/summary-row";
import { adoptionSummary, adoptionSummarySpuw } from "@/queries/adoption";

type Part = ReturnType<typeof useFilteredQuery>;
type Answers = readonly [CachedQueryResult | undefined, CachedQueryResult | undefined];

/**
 * The part has no answer yet for what's on screen: it's asking, it's waiting
 * for the task times, or its last ask failed without an answer and it still
 * holds one from before.
 */
function pending(part: Part): boolean {
    return part.isLoading || part.isRefreshing || (part.error !== undefined && part.data?.status !== "error");
}

/**
 * The Adoption summary, asked as two queries at once under the same filters:
 * `adoptionSummary`, and the five sessions-per-user-per-week figures in
 * `adoptionSummarySpuw`. Each column is a figure of its own in the same
 * filter context, so the two answer as the one query did, only sooner.
 *
 * The row holds both parts' answers to the same question. While either part
 * is still asking, it keeps the pair from before, as one query keeps its last
 * answer while it asks again, so no card mixes new figures with old ones.
 * "Try again" asks only the part that failed.
 */
export function useAdoptionSummary(ignore?: readonly FilterKey[]): SummaryResult {
    const core = useFilteredQuery(adoptionSummary(), { ignore });
    const spuw = useFilteredQuery(adoptionSummarySpuw(), { ignore });

    const settled = !pending(core) && !pending(spuw);
    const [held, setHeld] = useState<Answers>([core.data, spuw.data]);
    if (settled && (held[0] !== core.data || held[1] !== spuw.data)) {
        setHeld([core.data, spuw.data]);
    }
    const [coreData, spuwData] = settled ? [core.data, spuw.data] : held;

    const row = useMemo(() => {
        if (coreData?.status !== "success" || spuwData?.status !== "success") return undefined;
        const coreRow = toSummaryRow(coreData.table);
        const spuwRow = toSummaryRow(spuwData.table);
        return coreRow && spuwRow ? { ...coreRow, ...spuwRow } : undefined;
    }, [coreData, spuwData]);

    const coreFailed = coreData?.status === "error";
    const spuwFailed = spuwData?.status === "error";
    const failed = coreData?.status === "error" ? coreData : spuwData?.status === "error" ? spuwData : undefined;
    const { refetch: refetchCore } = core;
    const { refetch: refetchSpuw } = spuw;
    const refetch = useCallback(() => {
        if (coreFailed || !spuwFailed) void refetchCore();
        if (spuwFailed || !coreFailed) void refetchSpuw();
    }, [coreFailed, spuwFailed, refetchCore, refetchSpuw]);

    return {
        row,
        loaded: coreData?.status === "success" && spuwData?.status === "success",
        error: failed?.error.message,
        refetch,
        notFilteredBy: core.notFilteredBy,
    };
}
