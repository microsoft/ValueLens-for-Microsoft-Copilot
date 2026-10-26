//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { FilterContext, useFilterContext } from "@/hooks/filter.context";
import { PrefetchContext } from "@/hooks/prefetch.context";
import { pageStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { useAccessScope } from "@/hooks/use-access-scope";
import { getQueryScheduler } from "@/lib/fabric-client";
import type { QueryScheduler } from "@/lib/query-scheduler";
import type { Destination, DestinationId, StageId } from "./destinations";
import { prefetchTargets, type PrefetchTarget } from "./prefetch-targets";

/** Off switch: with it false, every page queries only when opened. */
export const PREFETCH = true;

/** How long nothing may be loading before the next page is fetched. */
export const IDLE_MS = 1500;

const targetKey = (target: PrefetchTarget) => `${target.id}/${target.stage}`;

type Activity = Pick<QueryScheduler, "activity" | "subscribe">;

/** Nothing is loading, and something has: the page that opened first has had its turn. */
function useSettled(scheduler: Activity): boolean {
    const subscribe = useCallback((listener: () => void) => scheduler.subscribe(listener), [scheduler]);
    const snapshot = useCallback(() => {
        const { foreground, background, finished } = scheduler.activity();
        return finished > 0 && foreground + background === 0;
    }, [scheduler]);
    return useSyncExternalStore(subscribe, snapshot);
}

function subscribeVisibility(listener: () => void): () => void {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
}

function usePageVisible(): boolean {
    return useSyncExternalStore(subscribeVisibility, () => !document.hidden);
}

/** Mounts after its sibling page has loaded its code, so a fetch isn't judged finished before it starts. */
function Loaded({ onLoaded }: { onLoaded: () => void }) {
    useEffect(onLoaded, [onLoaded]);
    return null;
}

interface PrefetcherProps {
    available: readonly Destination[];
    /** The page on screen, or `undefined` while a report pack is open. */
    current: DestinationId | undefined;
    stage: StageId | undefined;
    screens: Readonly<Partial<Record<DestinationId, ComponentType>>>;
    scheduler?: Activity;
    idleMs?: number;
}

/**
 * Once the page on screen has loaded, mounts the next few pages (see
 * `prefetchTargets`) one at a time, hidden, so their first view's queries
 * run in the scheduler's background lane and land in the result cache
 * before anyone opens them. Moving to another page fetches the pages after
 * that one. It waits whenever anything on screen is loading, and while the
 * app's tab is hidden.
 * A page opened while it is being fetched joins its queries in flight.
 *
 * Each page is fetched with the filters as they were when it started; a
 * change of filters drops it and starts again from the first page once
 * things are quiet. Charts aren't drawn and the refreshing bar isn't shown.
 */
export function Prefetcher({
    available,
    current,
    stage,
    screens,
    scheduler = getQueryScheduler(),
    idleMs = IDLE_MS,
}: PrefetcherProps) {
    const filterContext = useFilterContext();
    const scope = useAccessScope();
    const settled = useSettled(scheduler);
    const visible = usePageVisible();

    const signature = JSON.stringify(filterContext.filters);
    const targets = useMemo(() => prefetchTargets(available, current, stage), [available, current, stage]);
    const [done, setDone] = useState<{ signature: string; keys: ReadonlySet<string> }>({ signature, keys: new Set() });
    const [running, setRunning] = useState<{ target: PrefetchTarget; signature: string; loaded: boolean }>();
    const doneKeys = useMemo(
        () => (done.signature === signature ? done.keys : new Set<string>()),
        [done, signature],
    );
    const allowed = PREFETCH && current !== undefined && scope.kind !== "none" && scope.kind !== "checking";
    // A page started under other filters is dropped, and the next one starts under these.
    const active = running?.signature === signature ? running : undefined;

    useEffect(() => {
        // Waits while the app's tab is hidden, and until the page in hand has loaded its code.
        if (!allowed || !visible || !settled) return;
        if (active && !active.loaded) return;
        const timer = setTimeout(() => {
            const finished = active ? targetKey(active.target) : undefined;
            if (finished) setDone({ signature, keys: new Set([...doneKeys, finished]) });
            const next = targets.find((target) => !doneKeys.has(targetKey(target)) && targetKey(target) !== finished);
            setRunning(next ? { target: next, signature, loaded: false } : undefined);
        }, idleMs);
        return () => clearTimeout(timer);
    }, [allowed, visible, settled, active, targets, doneKeys, signature, idleMs]);

    const target = allowed ? active?.target : undefined;
    const Screen = target ? screens[target.id] : undefined;
    const applicable = useMemo(
        () => (target ? (available.find((destination) => destination.id === target.id)?.filters ?? []) : []),
        [available, target],
    );
    const frozen = useMemo(
        () => ({ ...filterContext, applicable }),
        // Frozen when the page starts, so a filter being changed doesn't fetch every step of the change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [running?.target, applicable],
    );
    const stageFilter = useMemo(() => (target ? pageStages(target.stage) : undefined), [target]);
    const markLoaded = useMemo(
        () => () => setRunning((previous) => (previous && !previous.loaded ? { ...previous, loaded: true } : previous)),
        [],
    );

    if (!target || !Screen || !stageFilter) return null;
    // Keyed, so each page gets a fresh error boundary and load sentinel.
    return (
        <div key={targetKey(target)} hidden inert aria-hidden data-prefetch={targetKey(target)}>
            {/* A page that fails here is left for its real visit to show the error. */}
            <ErrorBoundary fallback={null} onError={markLoaded}>
                <PrefetchContext.Provider value>
                    <FilterContext.Provider value={frozen}>
                        <StageFilterContext.Provider value={stageFilter}>
                            <Suspense fallback={null}>
                                <Screen />
                                <Loaded onLoaded={markLoaded} />
                            </Suspense>
                        </StageFilterContext.Provider>
                    </FilterContext.Provider>
                </PrefetchContext.Provider>
            </ErrorBoundary>
        </div>
    );
}
