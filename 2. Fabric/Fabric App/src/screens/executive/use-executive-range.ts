//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useFilterContext } from "@/hooks/filter.context";
import { shownDateRange } from "@/lib/filters";
import { executiveRange, type ExecutiveRange } from "./executive-data";

export interface ExecutiveRangeState {
    /** Undefined until the activity's first and last dates are known, or when there are none. */
    range: ExecutiveRange | undefined;
    /** True once the filter options have answered, with dates or without. */
    settled: boolean;
}

/**
 * The days the Executive summary covers: the date range, held to the days with
 * activity. The tenant's default window counts as its last 12 weeks once the
 * options say the tenant is large, and as every date otherwise.
 */
export function useExecutiveRange(): ExecutiveRangeState {
    const { filters, options, optionsError } = useFilterContext();
    const shown = shownDateRange(filters.dateRange, options);
    const from = shown?.from;
    const to = shown?.to;
    const firstDate = options?.firstDate;
    const lastDate = options?.lastDate;
    const range = useMemo(() => executiveRange(from, to, firstDate, lastDate), [from, to, firstDate, lastDate]);
    return { range, settled: options !== undefined || optionsError !== undefined };
}
