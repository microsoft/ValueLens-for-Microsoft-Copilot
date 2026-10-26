//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useMemo } from "react";
import { isConnectionConfigured } from "@/lib/connections";
import type { LoadStatus } from "@/lib/freshness";
import { runtimeConfig } from "@/lib/runtime-config";
import { loadStatus, readLoadStatus } from "@/queries/freshness";
import { useSemanticModelQuery } from "./use-semantic-model-query";

const QUERY = loadStatus();

/** The answer read this session; null when the query failed. */
let answer: LoadStatus[] | null | undefined;

/** Forgets the answer read so far. For tests. */
export function clearLoadStatus(): void {
    answer = undefined;
}

/**
 * How each load went on the latest pipeline run, read once a session from the
 * ValueLens model's `Load Log` table, and only when `wanted`. A model without
 * the table, or a failed query, reads as no answer, never an error. Nothing on
 * screen waits on it, so it's asked in the background lane, once the page has loaded.
 */
export function useLoadStatus(wanted: boolean): readonly LoadStatus[] | undefined {
    const { semanticModels } = runtimeConfig();
    const ask = wanted && answer === undefined && isConnectionConfigured(semanticModels, QUERY.connection);
    const { data, error } = useSemanticModelQuery({
        connection: QUERY.connection,
        query: ask ? QUERY.query : "",
        background: true,
    });

    const fresh = useMemo(() => {
        if (!ask) return undefined;
        if (data?.status === "success") return readLoadStatus(data.table);
        if (data?.status === "error" || error) return null;
        return undefined;
    }, [ask, data, error]);

    useEffect(() => {
        if (fresh !== undefined) answer = fresh;
    }, [fresh]);

    if (!wanted) return undefined;
    return (answer ?? fresh) ?? undefined;
}
