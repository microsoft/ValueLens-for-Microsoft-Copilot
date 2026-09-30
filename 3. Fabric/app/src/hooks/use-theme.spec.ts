//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY, useAppTheme } from "./use-theme";

afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
});

describe("useAppTheme", () => {
    it("opens in dark mode when nothing is saved", () => {
        const { result } = renderHook(() => useAppTheme());
        expect(result.current.isDark).toBe(true);
        expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("remembers a switch to light mode", () => {
        const first = renderHook(() => useAppTheme());
        act(() => first.result.current.toggleTheme());
        expect(first.result.current.isDark).toBe(false);
        expect(document.documentElement.classList.contains("dark")).toBe(false);
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
        first.unmount();

        const next = renderHook(() => useAppTheme());
        expect(next.result.current.isDark).toBe(false);
    });

    it("remembers switching back to dark mode", () => {
        window.localStorage.setItem(THEME_STORAGE_KEY, "light");
        const { result } = renderHook(() => useAppTheme());
        act(() => result.current.toggleTheme());
        expect(result.current.isDark).toBe(true);
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    });
});
