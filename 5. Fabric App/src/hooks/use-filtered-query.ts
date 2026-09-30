//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useMemo } from "react";
import { applyDaxFilters } from "@/lib/dax-filters";
import { filterExpressions, type FilterKey } from "@/lib/filters";
import { beginRefresh } from "@/lib/refresh-tracker";
import { useFilterContext } from "./filter.context";
import { useSemanticModelQuery } from "./use-semantic-model-query";

interface FilteredQueryOptions {
    /**
     * Filters this query deliberately ignores — usually because it already
     * splits by that dimension, or reads a catalogue rather than activity.
     */
    ignore?: readonly FilterKey[];
    /** Extra DAX filter arguments, such as a what-if parameter value. */
    extra?: readonly string[];
}

/**
 * {@link useSemanticModelQuery} with the filter bar applied: the query is
 * wrapped in `CALCULATETABLE` with one argument per active filter that the
 * current destination responds to.
 *
 * Once a query has data, a refetch keeps that data on screen — `isLoading`
 * stays false and the shell dims the canvas instead — so changing a filter
 * never collapses the page back to skeletons.
 */
export function useFilteredQuery(config: { connection: string; query: string }, options: FilteredQueryOptions = {}) {
    const { filters, applicable } = useFilterContext();
    const { ignore, extra } = options;
    const ignoreKey = ignore?.join("|") ?? "";
    const extraKey = extra?.join("\u0000") ?? "";

    const query = useMemo(() => {
        const ignored = new Set(ignoreKey ? ignoreKey.split("|") : []);
        const keys = applicable.filter((key) => !ignored.has(key));
        const extraFilters = extraKey ? extraKey.split("\u0000") : [];
        return applyDaxFilters(config.query, [...filterExpressions(filters, keys), ...extraFilters]);
    }, [config.query, filters, applicable, ignoreKey, extraKey]);

    const result = useSemanticModelQuery({ connection: config.connection, query });
    const isRefreshing = result.isLoading && result.data !== undefined;

    useEffect(() => (isRefreshing ? beginRefresh() : undefined), [isRefreshing]);

    return { ...result, isLoading: result.isLoading && result.data === undefined, isRefreshing };
}
