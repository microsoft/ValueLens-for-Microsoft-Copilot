//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ModelReferences } from "@/lib/connections";

/**
 * Which products an install shows: ValueLens only (`vl`), Consumption
 * Central only (`cc`), or both behind the band's switcher (`both`). The
 * deploy script bakes it in with `VITE_APP_VARIANT` and also writes it to
 * `fabric.config.json` as `app.variant`, which wins when present.
 */
export type AppVariant = "vl" | "cc" | "both";

export const APP_VARIANTS: readonly AppVariant[] = ["vl", "cc", "both"];

/** The model connections (`fabric.yaml` aliases) each variant may read. */
export const VARIANT_CONNECTIONS: Readonly<Record<AppVariant, readonly string[]>> = {
    vl: ["vl"],
    cc: ["cc"],
    both: ["vl", "cc"],
};

const APP_NAMES: Readonly<Record<AppVariant, string>> = {
    vl: "ValueLens",
    cc: "Consumption Central",
    both: "ValueLens + Consumption Central",
};

/** `value` as a variant, or undefined when it isn't one. */
export function toAppVariant(value: unknown): AppVariant | undefined {
    if (typeof value !== "string") return undefined;
    const key = value.trim().toLowerCase();
    return (APP_VARIANTS as readonly string[]).includes(key) ? (key as AppVariant) : undefined;
}

/**
 * The variant baked in at build time: `VITE_APP_VARIANT`, else a Vite mode
 * named after one (`vite --mode cc`), else `both`.
 */
export function buildTimeVariant(): AppVariant {
    return toAppVariant(import.meta.env.VITE_APP_VARIANT) ?? toAppVariant(import.meta.env.MODE) ?? "both";
}

/** The name the app goes by in its band, its title and its messages. */
export function appName(variant: AppVariant): string {
    return APP_NAMES[variant];
}

/**
 * Only the models `variant` may read. A ValueLens-only app never queries
 * Consumption Central even when its config names that model, and the
 * reverse, so each product's pages, filters and probes follow from this.
 */
export function scopeModels(models: ModelReferences, variant: AppVariant): ModelReferences {
    const allowed = VARIANT_CONNECTIONS[variant];
    return Object.fromEntries(Object.entries(models).filter(([alias]) => allowed.includes(alias)));
}

/** Reads `{ app: { variant } }` from a config body. */
export function parseAppVariant(json: unknown): AppVariant | undefined {
    if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
    const app = (json as Record<string, unknown>).app;
    if (typeof app !== "object" || app === null || Array.isArray(app)) return undefined;
    return toAppVariant((app as Record<string, unknown>).variant);
}
