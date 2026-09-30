//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect } from "react";

export const THEME_STORAGE_KEY = "valuelens.theme";

// Storage can be unavailable in a sandboxed embed; the theme then just isn't remembered.
function readSaved(): "dark" | "light" | undefined {
    try {
        const value = window.localStorage.getItem(THEME_STORAGE_KEY);
        return value === "dark" || value === "light" ? value : undefined;
    } catch {
        return undefined;
    }
}

function save(value: "dark" | "light") {
    try {
        window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
        // Not remembered; the toggle still works for this visit.
    }
}

/**
 * Dark by default. Anyone who switches to light mode keeps it on their next
 * visit, because the choice is saved in this browser. The OS and host themes
 * are deliberately not followed, so the app always opens the same way.
 */
export function useAppTheme() {
    const [isDark, setIsDark] = useState(() => readSaved() !== "light");

    useEffect(() => {
        // Sync the .dark class on <html> for Tailwind dark mode
        document.documentElement.classList.toggle("dark", isDark);
    }, [isDark]);

    const toggleTheme = () => {
        save(isDark ? "light" : "dark");
        setIsDark(!isDark);
    };

    return { isDark, toggleTheme };
}
