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
import { readsTaskTimes, withTaskTimes } from "@/queries/assumptions/task-times";
import { connection as valueLensConnection } from "@/queries/shared";
import { useFilterContext } from "./filter.context";
import { useTaskTimes } from "./task-times.context";
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
 * current destination responds to. A ValueLens query that shows hours or
 * value is worked out at the task times saved in the app, and waits, as an
 * empty query, until those are known.
 *
 * Once a query has data, a refetch keeps that data on screen — `isLoading`
 * stays false and the shell dims the canvas instead — so changing a filter
 * never collapses the page back to skeletons.
 */
export function useFilteredQuery(config: { connection: string; query: string }, options: FilteredQueryOptions = {}) {
    const { filters, applicable } = useFilterContext();
    const taskTimes = useTaskTimes();
    const { ignore, extra } = options;
    const ignoreKey = ignore?.join("|") ?? "";
    const extraKey = extra?.join("\u0000") ?? "";

    const timed = useMemo(() => {
        if (config.connection !== valueLensConnection) return config.query;
        if (taskTimes.status === "loading" && readsTaskTimes(config.query)) return "";
        return withTaskTimes(config.query, taskTimes.saved);
    }, [config.connection, config.query, taskTimes.status, taskTimes.saved]);

    const query = useMemo(() => {
        if (!timed) return "";
        const ignored = new Set(ignoreKey ? ignoreKey.split("|") : []);
        const keys = applicable.filter((key) => !ignored.has(key));
        const extraFilters = extraKey ? extraKey.split("\u0000") : [];
        return applyDaxFilters(timed, [...filterExpressions(filters, keys), ...extraFilters]);
    }, [timed, filters, applicable, ignoreKey, extraKey]);

    const result = useSemanticModelQuery({ connection: config.connection, query });
    const waiting = Boolean(config.query) && !timed;
    const isRefreshing = result.isLoading && result.data !== undefined;

    useEffect(() => (isRefreshing ? beginRefresh() : undefined), [isRefreshing]);

    return {
        ...result,
        isLoading: (result.isLoading || waiting) && result.data === undefined,
        isRefreshing,
    };
}
