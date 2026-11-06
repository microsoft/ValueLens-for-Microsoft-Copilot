//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import {
    reloadOnStaleBuild,
    STALE_BUILD_RELOAD_KEY,
    STALE_BUILD_RELOAD_WINDOW_MS,
} from "@/lib/reload-on-stale-build";

function fakeWindow(storage: Map<string, string> | null = new Map()) {
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    const sessionStorage = {
        getItem: (key: string) => {
            if (!storage) throw new Error("blocked");
            return storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
            if (!storage) throw new Error("blocked");
            storage.set(key, value);
        },
    };
    const win = {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        sessionStorage,
        location: { reload },
    } as unknown as Parameters<typeof reloadOnStaleBuild>[0];
    return { win, reload, fire: () => listeners.get("vite:preloadError")?.() };
}

describe("reloadOnStaleBuild", () => {
    it("reloads when a code chunk from the previous build can't be fetched", () => {
        const storage = new Map<string, string>();
        const { win, reload, fire } = fakeWindow(storage);
        reloadOnStaleBuild(win, () => 1_000_000);

        fire();

        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.get(STALE_BUILD_RELOAD_KEY)).toBe("1000000");
    });

    it("leaves the error showing if it fails again straight after reloading", () => {
        const storage = new Map([[STALE_BUILD_RELOAD_KEY, "1000000"]]);
        const { win, reload, fire } = fakeWindow(storage);
        reloadOnStaleBuild(win, () => 1_000_000 + STALE_BUILD_RELOAD_WINDOW_MS - 1);

        fire();

        expect(reload).not.toHaveBeenCalled();
    });

    it("reloads again for a later deploy", () => {
        const storage = new Map([[STALE_BUILD_RELOAD_KEY, "1000000"]]);
        const { win, reload, fire } = fakeWindow(storage);
        reloadOnStaleBuild(win, () => 1_000_000 + STALE_BUILD_RELOAD_WINDOW_MS);

        fire();

        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("doesn't reload without session storage, as nothing would stop a loop", () => {
        const { win, reload, fire } = fakeWindow(null);
        reloadOnStaleBuild(win, () => 1_000_000);

        fire();

        expect(reload).not.toHaveBeenCalled();
    });
});
