//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { resolveRayfinConfig, type RayfinRuntimeConfig } from "@microsoft/rayfin-client";
import * as teams from "@microsoft/teams-js";
import { fabricConfig } from "@/fabric.generated";
import type { ModelReference, ModelReferences } from "@/lib/connections";

/** Where an Azure install puts the host contract, next to the SPA. */
export const APP_CONFIG_PATH = "/app.config.json";
/** Where a Fabric install puts the semantic models it set up, next to the `rayfin.config.json` that `rayfin up` writes. */
export const FABRIC_CONFIG_PATH = "/fabric.config.json";

export type RuntimeHost = "fabric" | "azure";

export interface AzureRuntimeConfig {
    tenantId: string;
    clientId: string;
    apiScope: string;
    version?: string;
    inTeams: boolean;
}

export interface RuntimeConfig {
    /** The host that supplies auth, query transport and app settings. */
    host: RuntimeHost;
    /** The Rayfin backend and the Fabric item that hosts the app. Fabric-only. */
    rayfin: RayfinRuntimeConfig;
    /** Azure auth and host settings. Azure-only. */
    azure?: AzureRuntimeConfig;
    /** The semantic models each page queries, by connection alias. */
    semanticModels: ModelReferences;
    /** Optional installer modules chosen for this install. Undefined for older installs and Azure hosts that do not say. */
    modules?: RuntimeModules;
}

export interface RuntimeModules {
    m365Activity: boolean;
    agent365: boolean;
    productFeedback: boolean;
    consumption: boolean;
    agentEvaluator: boolean;
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
        host: "fabric",
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

/** The config loadRuntimeConfig settled on, or the build-time values before it has run. */
export function runtimeConfig(): RuntimeConfig {
    return loaded ?? buildTimeConfig();
}

/** Reads deployed host config over build-time defaults. */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    const defaults = buildTimeConfig();
    const azure = await loadAzureConfig(APP_CONFIG_PATH);
    if (azure) {
        loaded = {
            ...defaults,
            host: "azure",
            azure: { ...azure.azure!, inTeams: azure.azure!.inTeams || await detectTeams() },
            semanticModels: azure.semanticModels,
            modules: azure.modules,
        };
        return loaded;
    }

    const [rayfin, fabric] = await Promise.all([
        resolveRayfinConfig(defaults.rayfin),
        loadFabricConfig(FABRIC_CONFIG_PATH),
    ]);
    loaded = {
        host: "fabric",
        rayfin: rayfin.runtimeConfig,
        semanticModels: fabric?.semanticModels ?? defaults.semanticModels,
        modules: fabric?.modules,
    };
    return loaded;
}

/** Forgets the loaded config. For tests. */
export function resetRuntimeConfig(): void {
    loaded = undefined;
}

/** The Azure host config, or null when this is not an Azure-hosted install. */
export async function loadAzureConfig(path = APP_CONFIG_PATH): Promise<RuntimeConfig | null> {
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
    return parseAzureConfig(json, path);
}

export async function loadSemanticModels(path = FABRIC_CONFIG_PATH): Promise<ModelReferences | null> {
    const config = await loadFabricConfig(path);
    return config?.semanticModels ?? null;
}

export async function loadFabricConfig(path = FABRIC_CONFIG_PATH): Promise<Pick<RuntimeConfig, "semanticModels" | "modules"> | null> {
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
    return { semanticModels: parseSemanticModels(json, path), modules: parseModules(json) };
}

/** Checks an Azure app.config.json body has the host contract shape. */
export function parseAzureConfig(json: unknown, path = APP_CONFIG_PATH): RuntimeConfig {
    if (!isRecord(json) || json.host !== "azure")
        throw new RuntimeConfigError(`${path} needs host: "azure".`);
    const { tenantId, clientId, apiScope, version } = json;
    if (typeof tenantId !== "string" || typeof clientId !== "string" || typeof apiScope !== "string")
        throw new RuntimeConfigError(`${path} needs tenantId, clientId and apiScope.`);
    return {
        ...buildTimeConfig(),
        host: "azure",
        azure: {
            tenantId,
            clientId,
            apiScope,
            version: typeof version === "string" ? version : undefined,
            inTeams: queryRequestsTeams(),
        },
        semanticModels: parseSemanticModels(json, path),
        modules: parseModules(json),
    };
}

/** Checks a config body has the `{ semanticModels: { alias: { workspaceId, itemId } } }` shape. */
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

export function parseModules(json: unknown): RuntimeModules | undefined {
    const modules = isRecord(json) ? json.modules : undefined;
    if (!isRecord(modules)) return undefined;

    const keys = ["m365Activity", "agent365", "productFeedback", "consumption", "agentEvaluator"] as const;
    if (!keys.every((key) => typeof modules[key] === "boolean")) return undefined;
    return Object.fromEntries(keys.map((key) => [key, modules[key]])) as unknown as RuntimeModules;
}

function queryRequestsTeams(): boolean {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("host")?.toLowerCase() === "teams";
}

async function detectTeams(): Promise<boolean> {
    if (queryRequestsTeams()) return true;
    try {
        await teams.app.initialize();
        return true;
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
