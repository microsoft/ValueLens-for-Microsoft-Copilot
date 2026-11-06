//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { FILTER_KEYS } from "@/lib/filters";
import { m365Status, readM365Status, type M365Status } from "@/queries/work-patterns";
import { useSummaryQuery } from "./use-table-query";

const STATUS_QUERY = m365Status();
const NO_EXTRA: readonly string[] = [];

/**
 * Whether this install has Microsoft 365 activity to show, regardless of the
 * filter bar: the Work patterns page and the license score both change shape
 * on it, and neither should flip because a filter emptied the selection.
 */
export function useM365Activity(): M365Status & { refetch: () => void } {
    const { row, loaded, error, refetch } = useSummaryQuery(STATUS_QUERY, NO_EXTRA, FILTER_KEYS);
    const status = useMemo(() => readM365Status({ row, loaded, error }), [row, loaded, error]);
    return { ...status, refetch };
}
