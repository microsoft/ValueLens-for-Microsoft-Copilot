//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { readCssTheme, type VisualTheme } from "@microsoft/fabric-visuals-core";
import { useThemeContext } from "./theme.context";

/** The CSS class that switches a subtree onto a destination's palette. */
export function paletteClass(palette: string): string {
    return `palette-${palette}`;
}

/**
 * Reads CSS custom properties as they resolve inside a palette. A hidden
 * probe is used rather than a rendered element so the theme is ready on the
 * first render — charts never paint in the default palette and then repaint.
 */
function readInPalette<T>(palette: string, read: (element: HTMLElement) => T): T | undefined {
    if (typeof document === "undefined" || !document.body) return undefined;
    const probe = document.createElement("div");
    probe.className = paletteClass(palette);
    probe.hidden = true;
    document.body.appendChild(probe);
    try {
        return read(probe);
    } finally {
        probe.remove();
    }
}

/**
 * The visual theme for a destination: the app theme with the destination's
 * brand and categorical palette swapped in. Recomputed when the app switches
 * between light and dark.
 */
export function usePaletteTheme(palette: string): VisualTheme {
    const { theme } = useThemeContext();
    return useMemo(() => {
        const scoped = readInPalette(palette, (element) => readCssTheme(element));
        // The probe never carries the `dark` class itself; the app theme knows.
        return scoped ? { ...scoped, isDark: theme.isDark, isHighContrast: theme.isHighContrast } : theme;
    }, [palette, theme]);
}

export interface OutcomeColors {
    positive: string;
    negative: string;
    caution: string;
    neutral: string;
}

const OUTCOME_VARS: Record<keyof OutcomeColors, string> = {
    positive: "--vl-teal",
    negative: "--vl-coral",
    caution: "--vl-amber",
    neutral: "--vl-slate",
};

/**
 * Chart fills for outcomes — good, bad, worth a look, not judged — that keep
 * the same meaning in every destination, for specs whose colour encodes a
 * verdict rather than a category.
 */
export function useOutcomeColors(): OutcomeColors | undefined {
    const { theme } = useThemeContext();
    return useMemo(() => {
        // Depend on the theme so the colours follow a light/dark switch.
        void theme;
        return readInPalette("outcomes", (element) => {
            const style = getComputedStyle(element);
            const entries = Object.entries(OUTCOME_VARS).map(([key, name]) => [key, style.getPropertyValue(name).trim()]);
            return entries.every(([, value]) => value) ? (Object.fromEntries(entries) as unknown as OutcomeColors) : undefined;
        });
    }, [theme]);
}
