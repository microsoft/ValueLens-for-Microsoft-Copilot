//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useEffect, useMemo } from "react";
import { applyDaxFilters } from "@/lib/dax-filters";
import { defaultProfile, resolveFilters, type FilterProfile, type NotFiltered } from "@/lib/filter-profiles";
import type { FilterKey } from "@/lib/filters";
import { beginRefresh } from "@/lib/refresh-tracker";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { readsTaskTimes, withTaskTimes } from "@/queries/assumptions/task-times";
import { connection as valueLensConnection } from "@/queries/shared";
import { useFilterContext } from "./filter.context";
import { useIsPrefetch } from "./prefetch.context";
import { useTaskTimes } from "./task-times.context";
import { useSemanticModelQuery, useSpeculativeQuery } from "./use-semantic-model-query";

interface FilteredQueryOptions {
    /**
     * Filters this query deliberately ignores — usually because it already
     * splits by that dimension, or reads a catalogue rather than activity.
     */
    ignore?: readonly FilterKey[];
    /** Extra DAX filter arguments, such as a what-if parameter value. */
    extra?: readonly string[];
}

/** A query, and how it takes the filter bar when that differs from its model's default. */
export interface FilteredQueryConfig {
    connection: string;
    query: string;
    /**
     * Which filters reach the query, on which columns, and why the rest
     * can't. A ValueLens query takes every filter on the report's own
     * columns; a query on another model takes none unless it says how.
     */
    filters?: FilterProfile;
    /** The page's first view waits on this query: on screen it goes ahead of the other queries waiting. */
    lead?: boolean;
    /**
     * While the saved task times load, ask the query at the model's own
     * minutes, so it's on its way from the page's first query. Nothing shows
     * until the times are known. With none saved the card then joins that
     * query or reads its answer; with some saved it asks again at them, and
     * the first answer is wasted. Only for queries a page's first view waits
     * on, where an early answer is worth a wasted one when times are saved.
     */
    speculate?: boolean;
    /** How the answer's columns are read: see `useSemanticModelQuery`'s `columnMetadata`. */
    columnMetadata?: ColumnMetadataMap;
}

/**
 * {@link useSemanticModelQuery} with the filter bar applied: the query is
 * wrapped in `CALCULATETABLE` with one argument per active filter that the
 * current destination responds to, on the columns the query's filter
 * profile maps it to. Active filters the query can't take come back as
 * `notFilteredBy`, so the card can say so; filters in `ignore` are the
 * caller's to explain. A ValueLens query that shows hours or
 * value is worked out at the task times saved in the app, and waits, as an
 * empty query, until those are known; one that may `speculate` is asked
 * meanwhile at the model's own minutes, without showing that answer.
 *
 * Once a query has data, a refetch keeps that data on screen — `isLoading`
 * stays false and the shell dims the canvas instead — so changing a filter
 * never collapses the page back to skeletons.
 */
export function useFilteredQuery(config: FilteredQueryConfig, options: FilteredQueryOptions = {}) {
    const { filters, applicable, consumptionOrgAttributes, options: filterOptions } = useFilterContext();
    const largeTenant = filterOptions?.largeTenant;
    const profile = config.filters ?? defaultProfile(config.connection, valueLensConnection);
    const taskTimes = useTaskTimes();
    const { ignore, extra } = options;
    const ignoreKey = ignore?.join("|") ?? "";
    const extraKey = extra?.join("\u0000") ?? "";

    const timed = useMemo(() => {
        if (config.connection !== valueLensConnection) return config.query;
        if (taskTimes.status === "loading" && readsTaskTimes(config.query)) return "";
        return withTaskTimes(config.query, taskTimes.saved);
    }, [config.connection, config.query, taskTimes.status, taskTimes.saved]);
    const waiting = Boolean(config.query) && !timed;
    const prefetching = useIsPrefetch();
    // What the query is with no task times saved, as the card will ask it if none turn out to be.
    const untimed = config.speculate && waiting && !prefetching ? withTaskTimes(config.query, []) : "";

    const resolved = useMemo(() => {
        const ignored = new Set(ignoreKey ? ignoreKey.split("|") : []);
        const keys = applicable.filter((key) => !ignored.has(key));
        return resolveFilters(profile, filters, keys, { consumptionOrgAttributes, largeTenant });
    }, [profile, filters, applicable, ignoreKey, consumptionOrgAttributes, largeTenant]);

    const filtered = useCallback((dax: string) => {
        if (!dax) return "";
        const extraFilters = extraKey ? extraKey.split("\u0000") : [];
        return applyDaxFilters(dax, [...resolved.expressions, ...extraFilters]);
    }, [resolved.expressions, extraKey]);
    const query = useMemo(() => filtered(timed), [filtered, timed]);
    const speculative = useMemo(() => filtered(untimed), [filtered, untimed]);

    const result = useSemanticModelQuery({
        connection: config.connection,
        query,
        lead: config.lead,
        columnMetadata: config.columnMetadata,
    });
    // After the card's query: once the times are known, a card asking the same query joins the early one where it waits.
    useSpeculativeQuery({ connection: config.connection, query: speculative, lead: config.lead });
    const isRefreshing = result.isLoading && result.data !== undefined;
    // A page fetched ahead of a visit is off screen, so it doesn't show the refreshing bar.
    const signalsRefresh = isRefreshing && !prefetching;

    useEffect(() => (signalsRefresh ? beginRefresh() : undefined), [signalsRefresh]);

    return {
        ...result,
        isLoading: (result.isLoading || waiting) && result.data === undefined,
        isRefreshing,
        notFilteredBy: resolved.notFilteredBy as readonly NotFiltered[],
    };
}
