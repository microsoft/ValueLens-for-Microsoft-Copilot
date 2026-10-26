//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext, useEffect, type Dispatch, type SetStateAction } from "react";
import type { FilterOptions } from "@/queries/filters";
import { defaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute, type OrgAttribute } from "@/lib/org-attribute";
import { useIsPrefetch } from "./prefetch.context";

interface FilterContextValue {
    /** The current filters, with `orgAttribute` resolved to a column the model has. */
    filters: FilterState;
    setFilters: Dispatch<SetStateAction<FilterState>>;
    /** `undefined` until the option query returns. */
    options: FilterOptions | undefined;
    optionsError: Error | undefined;
    /** Asks for the options again, after they failed. */
    retryOptions?: () => void;
    /** The filters the current destination responds to. */
    applicable: readonly FilterKey[];
    /** The org column in use, named for display. */
    orgAttribute: OrgAttribute;
    /** Every org column worth grouping by; `Organization` alone until they load. */
    orgAttributes: readonly string[];
    /**
     * Values of the org column in use. `undefined` until a filter menu first
     * opens, then while they load, and while the org columns, which settle
     * that column, load.
     */
    orgValues: readonly string[] | undefined;
    /**
     * The org attributes Consumption Central holds for people: `undefined`
     * while they load (or when no provider supplies them), empty when the
     * model isn't connected or can't say. Only an org filter reads them, so
     * they load once a filter menu opens or an org filter is set.
     */
    consumptionOrgAttributes?: readonly string[];
    /**
     * Loads what only the filter menus show — the org values and Consumption
     * Central's org attributes — and the org columns on screen. A filter menu
     * other than the dates calls it as it opens.
     */
    requestFilterChoices?: () => void;
    /** Loads the org columns on screen rather than in the background: a breakdown by org groups by one. */
    requestOrgAttributes?: () => void;
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
    consumptionOrgAttributes: undefined,
});

export function useFilterContext(): FilterContextValue {
    return useContext(FilterContext);
}

/**
 * The org column that breakdowns "by organization" should group by. The org
 * columns load in the background, since the landing page groups nothing by
 * org. While `wanted` — a breakdown by org is on screen — they load on screen
 * instead, so the breakdown doesn't wait behind the page's other queries.
 */
export function useOrgAttribute(wanted = true): OrgAttribute {
    const { orgAttribute, requestOrgAttributes } = useContext(FilterContext);
    const prefetching = useIsPrefetch();
    useEffect(() => {
        if (wanted && !prefetching) requestOrgAttributes?.();
    }, [wanted, prefetching, requestOrgAttributes]);
    return orgAttribute;
}
