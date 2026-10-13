//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useFilterContext } from "@/hooks/filter.context";
import { executiveRange, type ExecutiveRange } from "./executive-data";

export interface ExecutiveRangeState {
    /** Undefined until the activity's first and last dates are known, or when there are none. */
    range: ExecutiveRange | undefined;
    /** True once the filter options have answered, with dates or without. */
    settled: boolean;
}

/** The days the Executive summary covers: the date range, held to the days with activity. */
export function useExecutiveRange(): ExecutiveRangeState {
    const { filters, options, optionsError } = useFilterContext();
    const from = filters.dateRange?.from;
    const to = filters.dateRange?.to;
    const firstDate = options?.firstDate;
    const lastDate = options?.lastDate;
    const range = useMemo(() => executiveRange(from, to, firstDate, lastDate), [from, to, firstDate, lastDate]);
    return { range, settled: options !== undefined || optionsError !== undefined };
}
