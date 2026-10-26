//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** `low` waits until nothing on screen is loading; `normal` is everything a person is looking at. */
export type QueryPriority = "normal" | "low";

/** The card starting a request. Once `signal` aborts, it is told nothing more about the request. */
export interface QueryCaller {
    /** Aborts once the card has gone, or has moved on to another query or model. */
    signal?: AbortSignal;
    /** Told the semantic model the request asks, as the scheduler names it. */
    asking?: (model: string) => void;
    /** Told, when the request gives up busy, the model's recovery count the busy answer is from. */
    gaveUp?: (model: string, recoveries: number) => void;
    /**
     * The page's first view waits on this card, as the landing page does on
     * its summary and trend. On screen, its request is let in ahead of the
     * other requests waiting on screen, behind any such request queued
     * before it; in the background lane it waits as any other.
     */
    lead?: boolean;
}

let current: QueryPriority = "normal";
let currentFrom: QueryCaller | undefined;

/**
 * Starts the requests `start` makes in `priority`'s lane, on behalf of
 * `caller`. The SDK checks its cache and calls the scheduled proxy
 * synchronously inside `query()`, so both are read before `start` returns;
 * anything later runs as `normal`, for no caller.
 */
export function withPriority<T>(priority: QueryPriority, start: () => T, caller?: QueryCaller): T {
    const previous = current;
    const previousFrom = currentFrom;
    current = priority;
    currentFrom = caller;
    try {
        return start();
    } finally {
        current = previous;
        currentFrom = previousFrom;
    }
}

/** The lane of the request being started right now. */
export function currentPriority(): QueryPriority {
    return current;
}

/** The card starting the request right now, if one said so. */
export function currentCaller(): QueryCaller | undefined {
    return currentFrom;
}
