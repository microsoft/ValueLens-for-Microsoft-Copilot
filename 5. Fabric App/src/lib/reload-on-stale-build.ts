//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

export const STALE_BUILD_RELOAD_KEY = "valuelens.staleBuildReload";

/** A second failure this soon after reloading means the chunk is missing for another reason. */
export const STALE_BUILD_RELOAD_WINDOW_MS = 30_000;

type ReloadWindow = Pick<Window, "addEventListener" | "sessionStorage"> & { location: Pick<Location, "reload"> };

/**
 * Each deploy replaces the app's code chunks with newly named ones. A page still running the
 * previous build then fails on its next page change with "Failed to fetch dynamically imported
 * module", and Try Again can't recover because the failed import is cached. Vite raises
 * `vite:preloadError` for that failure, so reload once to pick up the new build.
 */
export function reloadOnStaleBuild(win: ReloadWindow = window, now: () => number = Date.now): void {
    win.addEventListener("vite:preloadError", () => {
        try {
            const last = Number(win.sessionStorage.getItem(STALE_BUILD_RELOAD_KEY) ?? 0);
            if (now() - last < STALE_BUILD_RELOAD_WINDOW_MS) return;
            win.sessionStorage.setItem(STALE_BUILD_RELOAD_KEY, String(now()));
        } catch {
            // Without storage there's no guard against a reload loop, so leave the error showing.
            return;
        }
        win.location.reload();
    });
}
