//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { type CachedQueryResult } from "@microsoft/fabric-app-data";
import { isConnectionDeclared } from "@/lib/connections";
import { getFabricClient, QUERY_CACHE_MAX_AGE_MS } from "@/lib/fabric-client";
import { withPriority, type QueryCaller } from "@/lib/query-priority";
import { isBusyMessage, onModelRecovered, recoveriesOf } from "@/lib/query-scheduler";
import { runtimeConfig } from "@/lib/runtime-config";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { useIsPrefetch } from "./prefetch.context";

interface UseSemanticModelQueryOptions {
    /** Connection alias from fabric.yaml (e.g., "salesModel"). */
    connection: string;
    /** DAX query string. */
    query: string;
    /** If true, skip reading from cache (still writes the fresh result). */
    bypassCache?: boolean;
    /** The page's first view waits on this query: on screen it goes ahead of the other queries waiting. */
    lead?: boolean;
    /**
     * Nothing on screen waits on this query, so it waits in the background lane until the screen
     * has loaded. Turning it off moves a query still waiting to the screen's lane.
     */
    background?: boolean;
    /**
     * How the answer's columns are read. Each answer comes back with the
     * metadata its query was asked with, so an answer kept on screen while
     * a changed query loads is never read by that query's columns.
     */
    columnMetadata?: ColumnMetadataMap;
}

interface UseSemanticModelQueryResult {
    data: CachedQueryResult | undefined;
    /**
     * The column metadata to read `data` by: while `data` answers an earlier
     * query, the metadata that query was asked with; otherwise the query's own.
     */
    columnMetadata: ColumnMetadataMap | undefined;
    isLoading: boolean;
    error: Error | undefined;
    /** Runs the query again; after an error it asks Power BI rather than the cache. */
    refetch: () => Promise<void>;
}

/** A busy error the cache kept: Power BI was only asking the app to slow down, so ask again. */
function cachedBusy(result: CachedQueryResult): boolean {
    return result.fromCache && result.status === "error" && isBusyMessage(result.error.message);
}

/** The model has answered again since the busy answer the card holds, which `seen` dates. */
function outdated(model: string | undefined, seen: number): boolean {
    return model !== undefined && recoveriesOf(model) > seen;
}

type Execute = (fresh?: boolean, signal?: AbortSignal) => Promise<void>;

/** The answer a card shows, with the query it answers and the column metadata that query was asked with. */
interface Shown {
    data: CachedQueryResult;
    connection: string;
    query: string;
    columnMetadata: ColumnMetadataMap | undefined;
}

/**
 * React hook that executes a DAX query against a Power BI semantic model
 * via the Fabric SDK. Results are cached by the SDK's built-in LRU cache for
 * the rest of the visit, up to an hour each (`QUERY_CACHE_MAX_AGE_MS`). A card
 * left showing "Power BI is busy" asks again by itself once its model answers
 * another query.
 *
 * The connection alias is resolved from `fabric.generated.ts`
 * (managed by `npx fabric-app-data`).
 *
 * @example
 * // Basic usage
 * const { data, isLoading } = useSemanticModelQuery({
 *   connection: "salesModel",
 *   query: 'EVALUATE SUMMARIZE(Sales, Products[Name], "Total", SUM(Sales[Amount]))',
 * });
 *
 * if (data?.status === "success") {
 *   const table = data.table;
 *   // table.columns, table.rows
 * }
 *
 * @example
 * // Handling errors (SDK never throws — check result.status)
 * if (data?.status === "error") {
 *   console.error(data.error.message); // e.g., "401 Unauthorized"
 * }
 *
 * @example
 * // Checking cache status
 * if (data?.fromCache) {
 *   console.log(`Cached at ${data.cachedAt}`);
 * }
 *
 * @example
 * // Bypassing cache for fresh data
 * const { data } = useSemanticModelQuery({
 *   connection: "salesModel",
 *   query: 'EVALUATE ...',
 *   bypassCache: true,
 * });
 */
export function useSemanticModelQuery(
    options: UseSemanticModelQueryOptions,
): UseSemanticModelQueryResult {
    const { connection, query, bypassCache, lead, background, columnMetadata } = options;
    // Kept across a change of query, so the last answer stays on screen while the next loads.
    const [shown, setShown] = useState<Shown | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | undefined>();
    const latest = useRef<CachedQueryResult | undefined>(undefined);
    /** The card's current inputs, as the `execute` made for them, and what aborts once they change or the card goes. */
    const lifetime = useRef<{ execute: Execute; run: AbortController } | undefined>(undefined);
    /** Counts the card's asks: only the latest may change what it shows. */
    const asks = useRef(0);
    /** The model the card's answer came from, as the scheduler names it. */
    const asked = useRef<string | undefined>(undefined);
    /** That model's recovery count as of the answer the card holds. */
    const seen = useRef(0);
    /** The card shows "Power BI is busy" and isn't asking again yet. */
    const busy = useRef(false);
    /**
     * Whether the page's first view waits on the card, read when it asks. Only the queue order
     * depends on it, so a change mustn't call off and send again a query that is already on its way.
     */
    const leading = useRef(lead);
    /** The column metadata as last rendered, which an ask pairs its answer with. */
    const metadata = useRef(columnMetadata);

    const canExecute = Boolean(connection && query && isConnectionDeclared(runtimeConfig().semanticModels, connection));
    const priority = useIsPrefetch() || background ? "low" : "normal";

    // Declared before the effect that asks, so an ask made in the same commit sees the change.
    useEffect(() => {
        leading.current = lead;
        metadata.current = columnMetadata;
    });

    // Asks once. True when it ended busy on an answer from before its model last answered again.
    // Only the card's latest ask changes what it shows. An older ask, or one whose card has gone or
    // changed query, is ignored, and so is anything its requests report.
    const ask = useCallback(async (fresh: boolean, signal?: AbortSignal): Promise<boolean> => {
        if (signal?.aborted) return false;
        const mine = ++asks.current;
        const current = () => asks.current === mine && !signal?.aborted;
        const reading = metadata.current;
        busy.current = false;
        if (!canExecute) {
            setIsLoading(false);
            return false;
        }
        setIsLoading(true);
        setError(undefined);
        // What this ask's own requests report, kept here until the answer is known to still be the card's.
        let model: string | undefined;
        let stamp = 0;
        const caller: QueryCaller = {
            signal,
            lead: leading.current,
            asking: (name) => {
                model = name;
                stamp = recoveriesOf(name);
            },
            // The query it joined may have begun before a recovery this card was told of.
            gaveUp: (name, recoveries) => {
                model = name;
                stamp = recoveries;
            },
        };

        let held = false;
        try {
            const semanticModel = getFabricClient().semanticModel(connection);
            let result = await withPriority(priority, () => semanticModel.query(query, { bypassCache: fresh || bypassCache }), caller);
            if (!current()) return false;
            const stale = result.fromCache && result.cachedAt && Date.now() - result.cachedAt.getTime() > QUERY_CACHE_MAX_AGE_MS;
            if (stale || cachedBusy(result)) {
                result = await withPriority(priority, () => semanticModel.query(query, { bypassCache: true }), caller);
                if (!current()) return false;
            }

            latest.current = result;
            setShown({ data: result, connection, query, columnMetadata: reading });

            if (result.status === "error") {
                held = isBusyMessage(result.error.message);
                setError(new Error(result.error.message));
            }
        } catch (err) {
            if (!current()) return false;
            latest.current = undefined;
            const failure = err instanceof Error ? err : new Error(String(err));
            held = isBusyMessage(failure.message);
            setError(failure);
        } finally {
            if (current()) setIsLoading(false);
        }
        asked.current = model;
        seen.current = stamp;
        const missed = held && outdated(model, stamp);
        busy.current = held && !missed;
        return missed;
    }, [connection, query, bypassCache, canExecute, priority]);

    // `signal` aborts when the card unmounts or its query changes: what is still queued stops, and the answer is ignored.
    const execute = useCallback(async (fresh = false, signal?: AbortSignal) => {
        let again = await ask(fresh, signal);
        while (again && !signal?.aborted) again = await ask(true, signal);
    }, [ask]);

    useEffect(() => {
        const run = new AbortController();
        lifetime.current = { execute, run };
        // Starts a fetch from the semantic model; the loading flag must flip as it starts.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        execute(false, run.signal);
        return () => run.abort();
    }, [execute]);

    // A card that gave up with "Power BI is busy" asks again once its model answers another query.
    useEffect(() => onModelRecovered((model) => {
        const life = lifetime.current;
        if (life?.execute !== execute || life.run.signal.aborted) return;
        if (!busy.current || model !== asked.current || !outdated(model, seen.current)) return;
        void execute(true, life.run.signal);
    }), [execute]);

    // "Try again" after an error asks Power BI, not the cache that kept it; after a success the cache is right.
    // One kept from before the card changed query does nothing.
    const refetch = useCallback(() => {
        const life = lifetime.current;
        if (life?.execute !== execute || life.run.signal.aborted) return Promise.resolve();
        return execute(latest.current?.status !== "success", life.run.signal);
    }, [execute]);

    // An answer to an earlier query keeps that query's columns until the new answer replaces it.
    const earlier = shown !== undefined && (shown.connection !== connection || shown.query !== query);
    return {
        data: shown?.data,
        columnMetadata: earlier ? shown.columnMetadata : columnMetadata,
        isLoading,
        error,
        refetch,
    };
}

/**
 * Asks a query before the card that shows it can, and shows nothing itself:
 * the card that then asks the same query joins it while it's being answered,
 * or reads its answer from the cache. Once the query changes or the page goes
 * it's called off: a query still waiting stops, and one already sent finishes.
 *
 * It asks in a layout effect, because React runs a page's effects after its
 * stages' effects, and their queries would otherwise take every free slot first.
 * It calls a query off in an effect, after the effects of the hooks called
 * before it in the same component. Call it after the card's own query, so a
 * card that now asks the same one joins it first, and it keeps its place in
 * the queue.
 */
export function useSpeculativeQuery(options: Omit<UseSemanticModelQueryOptions, "bypassCache">): void {
    const { connection, query, lead } = options;
    const priority = useIsPrefetch() ? "low" : "normal";
    /** Read when it asks, as the card does, so a change doesn't call off a query already on its way. */
    const leading = useRef(lead);
    /** The queries it has moved on from, called off once the card has asked. */
    const ended = useRef<AbortController[]>([]);

    useLayoutEffect(() => {
        leading.current = lead;
    });

    useLayoutEffect(() => {
        if (!connection || !query || !isConnectionDeclared(runtimeConfig().semanticModels, connection)) return;
        const runs = ended.current;
        const run = new AbortController();
        // The answer is the card's to read, and a failure the card's to meet when it asks.
        try {
            const semanticModel = getFabricClient().semanticModel(connection);
            void withPriority(priority, () => semanticModel.query(query), { signal: run.signal, lead: leading.current })
                .catch(() => undefined);
        } catch {
            // Thrown before the query starts, as for a model that isn't set up.
        }
        return () => {
            runs.push(run);
        };
    }, [connection, query, priority]);

    // React runs every layout effect of a change before any effect, and a component's effects in order.
    useEffect(() => {
        callOff(ended.current);
    });

    useEffect(() => {
        const runs = ended.current;
        return () => callOff(runs);
    }, []);
}

function callOff(runs: AbortController[]): void {
    for (const run of runs.splice(0)) run.abort();
}

/**
 * Clears cached query results from the SDK's LRU cache.
 * Pass a connection alias to clear a specific model, or omit to clear all.
 *
 * @example
 * clearQueryCache();              // clear all models
 * clearQueryCache("salesModel");  // clear a specific model
 */
export function clearQueryCache(connection?: string): void {
    if (connection) {
        getFabricClient().semanticModel(connection).clearCache();
    } else {
        getFabricClient().clearCache();
    }
}
