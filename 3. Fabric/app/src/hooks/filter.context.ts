//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { FilterOptions } from "@/queries/filters";
import { defaultFilters, type FilterKey, type FilterState } from "@/lib/filters";

interface FilterContextValue {
    filters: FilterState;
    setFilters: Dispatch<SetStateAction<FilterState>>;
    /** `undefined` until the option query returns. */
    options: FilterOptions | undefined;
    optionsError: Error | undefined;
    /** The filters the current destination responds to. */
    applicable: readonly FilterKey[];
}

const noop = () => {};

/**
 * Filter state shared by every destination, so a date range or organization
 * chosen on one survives the move to the next.
 *
 * Without a provider — in isolated component tests — nothing is filtered.
 */
export const FilterContext = createContext<FilterContextValue>({
    filters: defaultFilters,
    setFilters: noop,
    options: undefined,
    optionsError: undefined,
    applicable: [],
});

export function useFilterContext(): FilterContextValue {
    return useContext(FilterContext);
}
