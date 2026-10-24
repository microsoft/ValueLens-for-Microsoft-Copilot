//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import {
    isDestinationReady,
    isPackable,
    isReference,
    openStage,
    type Destination,
    type DestinationId,
    type StageId,
} from "./destinations";

export interface PrefetchTarget {
    id: DestinationId;
    stage: StageId;
}

/**
 * How many tabs are fetched ahead of the page on screen. Fetching every page
 * ran about 45 background queries per open. They share the capacity with the
 * page on screen, and on large tenants each query runs longer and slows the
 * ones in front of it, so only the next pages are worth it.
 */
export const PREFETCH_AHEAD = 2;

/**
 * What to fetch ahead, in order: the tab each other page opens on, in menu
 * order starting after the page on screen and wrapping round, then the open
 * page's other tabs. Only the first `limit` are kept. Reference pages hold
 * no activity, and Ask runs nothing until a question is asked.
 */
export function prefetchTargets(
    available: readonly Destination[],
    current: DestinationId | undefined,
    currentStage: StageId | undefined,
    limit = PREFETCH_AHEAD,
): PrefetchTarget[] {
    const at = available.findIndex((destination) => destination.id === current);
    const after = at < 0 ? available : [...available.slice(at + 1), ...available.slice(0, at)];
    const targets: PrefetchTarget[] = [];
    for (const destination of after) {
        if (isReference(destination) || !isPackable(destination)) continue;
        if (!isDestinationReady(destination)) continue;
        const stage = openStage(destination);
        if (stage) targets.push({ id: destination.id, stage });
    }
    const page = at < 0 ? undefined : available[at];
    for (const stage of page?.stages ?? [])
        if (stage.ready && stage.id !== currentStage) targets.push({ id: page!.id, stage: stage.id });
    return targets.slice(0, Math.max(0, limit));
}
