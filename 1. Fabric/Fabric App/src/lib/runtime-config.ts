//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { resolveRayfinConfig, type RayfinRuntimeConfig } from "@microsoft/rayfin-client";
import { fabricConfig } from "@/fabric.generated";
import type { ModelReference, ModelReferences } from "@/lib/connections";

/** Where an install puts the semantic models it set up, next to the `rayfin.config.json` that `rayfin up` writes. */
export const FABRIC_CONFIG_PATH = "/fabric.config.json";

/**
 * What the app connects to. A developer build bakes these in from `.env.local` and
 * `fabric.yaml`; the prebuilt bundle the installer ships has neither, so it reads
 * them from the files deployed next to it instead.
 */
export interface RuntimeConfig {
    /** The Rayfin backend and the Fabric item that hosts the app. */
    rayfin: RayfinRuntimeConfig;
    /** The semantic models each page queries, by connection alias. */
    semanticModels: ModelReferences;
}

export class RuntimeConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RuntimeConfigError";
    }
}

let loaded: RuntimeConfig | undefined;

/** The values baked in at build time. */
export function buildTimeConfig(): RuntimeConfig {
    return {
        rayfin: {
            apiUrl: import.meta.env.VITE_RAYFIN_API_URL || undefined,
            publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY || undefined,
            workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID || undefined,
            itemId: import.meta.env.VITE_FABRIC_ITEM_ID || undefined,
            portalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL || undefined,
            tenantId: import.meta.env.VITE_FABRIC_TENANT_ID || undefined,
        },
        semanticModels: fabricConfig.semanticModels as ModelReferences,
    };
}

/** The config {@link loadRuntimeConfig} settled on, or the build-time values before it has run. */
export function runtimeConfig(): RuntimeConfig {
    return loaded ?? buildTimeConfig();
}

/**
 * Reads the deployed config files over the build-time values. Runs once, before the
 * app renders, so everything after it can read {@link runtimeConfig} synchronously.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    const defaults = buildTimeConfig();
    const [rayfin, semanticModels] = await Promise.all([
        resolveRayfinConfig(defaults.rayfin),
        loadSemanticModels(FABRIC_CONFIG_PATH),
    ]);
    loaded = {
        rayfin: rayfin.runtimeConfig,
        semanticModels: semanticModels ?? defaults.semanticModels,
    };
    return loaded;
}

/** Forgets the loaded config. For tests. */
export function resetRuntimeConfig(): void {
    loaded = undefined;
}

/**
 * The semantic models in a deployed `fabric.config.json`, or `null` when there isn't one.
 * A developer deploy doesn't write the file, and hosts answer a missing file with a 404
 * or the app's own page, so both mean "use the build's models". Anything else that stops
 * the file loading is an error: falling back would quietly show the wrong tenant's data.
 */
export async function loadSemanticModels(path = FABRIC_CONFIG_PATH): Promise<ModelReferences | null> {
    let response: Response;
    try {
        response = await fetch(path, { cache: "no-store" });
    } catch (error) {
        throw new RuntimeConfigError(`Couldn't load ${path}: ${error instanceof Error ? error.message : String(error)}.`);
    }

    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new RuntimeConfigError(`Couldn't load ${path}: ${response.status} ${response.statusText}.`);

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const body = (await response.text()).trimStart();
    if (contentType.includes("html") || body.startsWith("<"))
        return null;

    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new RuntimeConfigError(`${path} isn't valid JSON.`);
    }
    return parseSemanticModels(json, path);
}

/** Checks a `fabric.config.json` body has the `{ semanticModels: { alias: { workspaceId, itemId } } }` shape. */
export function parseSemanticModels(json: unknown, path = FABRIC_CONFIG_PATH): ModelReferences {
    const models = isRecord(json) ? json.semanticModels : undefined;
    if (!isRecord(models))
        throw new RuntimeConfigError(`${path} needs a "semanticModels" object.`);

    const parsed: Record<string, ModelReference> = {};
    for (const [alias, model] of Object.entries(models)) {
        if (!isRecord(model) || typeof model.workspaceId !== "string" || typeof model.itemId !== "string")
            throw new RuntimeConfigError(`${path} has no workspaceId and itemId for "${alias}".`);
        parsed[alias] = { workspaceId: model.workspaceId, itemId: model.itemId };
    }
    return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
