//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useSyncExternalStore } from "react";

/**
 * Counts queries that are refetching behind data already on screen, so the
 * shell can show one quiet "updating" state instead of every card falling
 * back to a skeleton each time a filter changes.
 */
let pending = 0;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Marks one refetch as in flight; call the returned function when it settles. */
export function beginRefresh(): () => void {
    pending++;
    emit();
    let done = false;
    return () => {
        if (done) return;
        done = true;
        pending--;
        emit();
    };
}

/** True while any query is refetching behind stale data. */
export function useIsRefreshing(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => pending > 0,
        () => false,
    );
}
