//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { FilterOptions } from "@/queries/filters";
import { defaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute, type OrgAttribute } from "@/lib/org-attribute";

interface FilterContextValue {
    /** The current filters, with `orgAttribute` resolved to a column the model has. */
    filters: FilterState;
    setFilters: Dispatch<SetStateAction<FilterState>>;
    /** `undefined` until the option query returns. */
    options: FilterOptions | undefined;
    optionsError: Error | undefined;
    /** The filters the current destination responds to. */
    applicable: readonly FilterKey[];
    /** The org column in use, named for display. */
    orgAttribute: OrgAttribute;
    /** Every org column worth grouping by; `Organization` alone until they load. */
    orgAttributes: readonly string[];
    /** Values of the org column in use; `undefined` while they load. */
    orgValues: readonly string[] | undefined;
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
    orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
    orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
    orgValues: undefined,
});

export function useFilterContext(): FilterContextValue {
    return useContext(FilterContext);
}

/** The org column that breakdowns "by organization" should group by. */
export function useOrgAttribute(): OrgAttribute {
    return useContext(FilterContext).orgAttribute;
}
