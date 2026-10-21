//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect, useCallback } from "react";
import { type CachedQueryResult } from "@microsoft/fabric-app-data";
import { getFabricClient, QUERY_CACHE_MAX_AGE_MS } from "@/lib/fabric-client";

interface UseSemanticModelQueryOptions {
    /** Connection alias from fabric.yaml (e.g., "salesModel"). */
    connection: string;
    /** DAX query string. */
    query: string;
    /** If true, skip reading from cache (still writes the fresh result). */
    bypassCache?: boolean;
}

interface UseSemanticModelQueryResult {
    data: CachedQueryResult | undefined;
    isLoading: boolean;
    error: Error | undefined;
    /** Runs the query again. A cached error is asked again, not read back from the cache. */
    refetch: () => Promise<void>;
}

/**
 * A result the cache gave that the model should be asked for again: one held
 * longer than `QUERY_CACHE_MAX_AGE_MS`, or an error, such as data that hadn't
 * loaded yet, which the model may have got past since.
 */
function askAgain(result: CachedQueryResult): boolean {
    if (!result.fromCache) return false;
    if (result.status === "error") return true;
    return result.cachedAt !== undefined && Date.now() - result.cachedAt.getTime() > QUERY_CACHE_MAX_AGE_MS;
}

/**
 * React hook that executes a DAX query against a Power BI semantic model
 * via the Fabric SDK. Results are cached by the SDK's built-in LRU cache for
 * the rest of the visit, up to an hour each (`QUERY_CACHE_MAX_AGE_MS`). A
 * cached error isn't reused: the hook asks the model again, so a page you go
 * back to, or "Try again", doesn't show an error the model may have got past.
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
    const { connection, query, bypassCache } = options;
    const [data, setData] = useState<CachedQueryResult | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | undefined>();

    const canExecute = Boolean(connection && query);

    const execute = useCallback(async () => {
        if (!canExecute) return;
        setIsLoading(true);
        setError(undefined);

        try {
            const model = getFabricClient().semanticModel(connection);
            let result = await model.query(query, { bypassCache });
            if (askAgain(result)) result = await model.query(query, { bypassCache: true });

            setData(result);

            if (result.status === "error") {
                setError(new Error(result.error.message));
            }
        } catch (err) {
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            setIsLoading(false);
        }
    }, [connection, query, bypassCache, canExecute]);

    useEffect(() => {
        // Starts a fetch from the semantic model; the loading flag must flip as it starts.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        execute();
    }, [execute]);

    return { data, isLoading, error, refetch: execute };
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
